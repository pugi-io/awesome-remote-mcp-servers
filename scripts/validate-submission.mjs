#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const probeEndpoints = args.includes('--probe');
const baseRef = args.find((arg) => arg !== '--probe') ?? 'origin/main';

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function fail(message) {
  console.error(`Submission validation failed: ${message}`);
  process.exitCode = 1;
}

let baseReadme;
let diff;
try {
  baseReadme = git('show', `${baseRef}:README.md`);
  diff = git('diff', '--no-ext-diff', '--unified=0', baseRef, '--', 'README.md');
} catch {
  console.error(`Cannot read ${baseRef}:README.md. Fetch the base branch or pass its local ref.`);
  process.exit(2);
}

const existingEndpoints = new Set(
  [...baseReadme.matchAll(/`(https:\/\/[^`\s]+)`/g)].map((match) => normalizeEndpoint(match[1])),
);
const addedLines = diff.split('\n')
  .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  .map((line) => line.slice(1));

const entryHead = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s+`(https?:\/\/[^`\s]+)`\s*$/;
const badgeLine = /^\s+\[!\[[^\]]*\]\(https:\/\/glama\.ai\/mcp\/connectors\/([^/\s]+\/[^/\s]+)\/badges\/score\.svg\)\]\((https?:\/\/[^)\s]+)\)\s*$/;
const markerLine = /^\s+([🔓🔑🔐][\s\S]*?)\s+-\s+(\S.*)$/u;
const entries = [];

for (const line of addedLines) {
  const head = line.match(entryHead);
  if (head) {
    entries.push({ name: head[1], endpoint: head[3], badge: null, markers: null, description: null });
    continue;
  }

  const current = entries.at(-1);
  if (!current) continue;
  const badge = line.match(badgeLine);
  if (badge) {
    current.badge = badge[1];
    continue;
  }
  const marker = line.match(markerLine);
  if (marker) {
    current.markers = marker[1].trim();
    current.description = marker[2].trim();
  }
}

const fresh = entries.filter((entry) => !existingEndpoints.has(normalizeEndpoint(entry.endpoint)));
const seenEndpoints = new Set(existingEndpoints);
for (const entry of entries) {
  const endpoint = normalizeEndpoint(entry.endpoint);
  if (seenEndpoints.has(endpoint)) fail(`${entry.name}: endpoint already exists (${entry.endpoint})`);
  seenEndpoints.add(endpoint);
}

for (const entry of fresh) {
  if (!entry.badge) fail(`${entry.name}: add a Glama connector badge on the second line`);
  if (!entry.markers || !entry.description) {
    fail(`${entry.name}: add an auth marker and one-sentence description on the third line`);
    continue;
  }
  if (!['🔓', '🔑', '🔐'].some((marker) => entry.markers.includes(marker))) {
    fail(`${entry.name}: use 🔓, 🔑, or 🔐 as the auth marker`);
  }
  if ([...entry.markers].some((character) => /\p{Extended_Pictographic}/u.test(character)
    && !['🔓', '🔑', '🔐'].some((marker) => marker.includes(character)))) {
    fail(`${entry.name}: remove unrecognized emoji from the auth marker`);
  }
  if (!entry.description.endsWith('.')) fail(`${entry.name}: description must end with a period`);
}

if (probeEndpoints) {
  const initBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'awesome-remote-mcp-servers-check', version: '1.0.0' } },
  });
  for (const entry of fresh) {
    try {
      const response = await fetch(entry.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          'User-Agent': 'awesome-remote-mcp-servers-check/1.0',
        },
        body: initBody,
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      const text = await response.text();
      const payload = text.includes('data:')
        ? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('')
        : text;
      const authenticated = response.status === 401 || response.status === 403;
      let initialized = false;
      try { initialized = Boolean(JSON.parse(payload).result); } catch { /* Non-JSON response. */ }
      if (!authenticated && !initialized) fail(`${entry.name}: endpoint did not complete initialize (HTTP ${response.status})`);
      const detectedMarker = authenticated
        ? (/resource_metadata|Bearer/i.test(response.headers.get('www-authenticate') ?? '') ? '🔐' : '🔑')
        : '🔓';
      if (entry.markers && !entry.markers.includes(detectedMarker)) {
        fail(`${entry.name}: endpoint indicates ${detectedMarker} authentication, but README says ${entry.markers}`);
      }
      if (entry.badge) {
        const badgeResponse = await fetch(`https://glama.ai/mcp/connectors/${entry.badge}`, {
          signal: AbortSignal.timeout(20000),
          headers: { 'User-Agent': 'awesome-remote-mcp-servers-check/1.0' },
        });
        if (!badgeResponse.ok) fail(`${entry.name}: Glama connector ${entry.badge} returned HTTP ${badgeResponse.status}`);
      }
    } catch (error) {
      fail(`${entry.name}: endpoint or badge probe failed (${String(error.message ?? error).slice(0, 120)})`);
    }
  }
}

if (process.exitCode) process.exit();
console.log(`Submission validation passed (${fresh.length} new entr${fresh.length === 1 ? 'y' : 'ies'}).`);

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '').toLowerCase();
}
