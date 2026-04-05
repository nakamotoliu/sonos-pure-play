import { normalizeText, normalizeWhitespace, SkillError } from './normalize.mjs';

function groupIncludesRoom(group, room) {
  if (!group) return true;
  return group.toLowerCase().includes(room.toLowerCase());
}

function normalizeRowText(value) {
  return normalizeText(normalizeWhitespace(value || ''));
}

function extractWebPlaylistRows(detailRows = [], limit = 10) {
  return (Array.isArray(detailRows) ? detailRows : [])
    .slice(0, limit)
    .map((row, index) => {
      if (typeof row === 'string') {
        const parts = row.split('|').map((part) => normalizeWhitespace(part)).filter(Boolean);
        const [title = '', artist = '', album = ''] = parts;
        return {
          index,
          title,
          artist,
          album,
          normalizedKey: normalizeRowText([title, artist].filter(Boolean).join(' ')),
        };
      }
      return {
        index,
        title: normalizeWhitespace(row?.title || ''),
        artist: normalizeWhitespace(row?.artist || ''),
        album: normalizeWhitespace(row?.album || ''),
        normalizedKey: normalizeRowText([row?.title, row?.artist].filter(Boolean).join(' ')),
      };
    })
    .filter((row) => row.title && row.normalizedKey);
}

function splitChunkAgainstCliRow(chunk, cliRow = null) {
  const normalizedChunk = normalizeWhitespace(chunk || '');
  if (!normalizedChunk) return null;
  const normalizedChunkKey = normalizeRowText(normalizedChunk);

  if (cliRow?.title && cliRow?.artist) {
    const titleKey = normalizeRowText(cliRow.title);
    const artistKey = normalizeRowText(cliRow.artist);
    if (normalizedChunkKey === `${titleKey} ${artistKey}`.trim() || normalizedChunkKey === `${titleKey}${artistKey}`.trim()) {
      return {
        title: normalizeWhitespace(cliRow.title),
        artist: normalizeWhitespace(cliRow.artist),
      };
    }
    if (normalizedChunk.startsWith(cliRow.title) && normalizedChunk.endsWith(cliRow.artist)) {
      return {
        title: normalizeWhitespace(cliRow.title),
        artist: normalizeWhitespace(cliRow.artist),
      };
    }
  }

  const spaced = normalizedChunk.match(/^(.+?)\s+([^\s].*)$/u);
  if (spaced) {
    return {
      title: normalizeWhitespace(spaced[1]),
      artist: normalizeWhitespace(spaced[2]),
    };
  }

  return {
    title: normalizedChunk,
    artist: '',
  };
}

function parsePlaylistRowsFromTextBlock(text = '', limit = 10, cliRows = []) {
  const normalized = normalizeWhitespace(text || '');
  if (!normalized) return [];
  const marker = normalized.includes('标题时间') ? '标题时间' : normalized.includes('标题 时间') ? '标题 时间' : null;
  if (!marker) return [];
  const afterHeader = normalized.split(marker)[1] || '';
  const stopMarkers = ['工作室', '客厅 play5', '小房间', '主卧', '将工作室设置为有效', '将客厅 play5设置为有效'];
  let content = afterHeader;
  for (const stop of stopMarkers) {
    const idx = content.indexOf(stop);
    if (idx > 0) {
      content = content.slice(0, idx);
      break;
    }
  }
  const matches = [...content.matchAll(/(.+?)(\d{1,2}:\d{2})/g)];
  const rows = [];
  for (const match of matches) {
    const chunk = normalizeWhitespace(match[1]);
    if (!chunk) continue;
    const cliRow = Array.isArray(cliRows) ? cliRows[rows.length] || null : null;
    const split = splitChunkAgainstCliRow(chunk, cliRow);
    if (!split?.title) continue;
    rows.push({
      index: rows.length,
      title: split.title,
      artist: split.artist || '',
      album: '',
      normalizedKey: normalizeRowText([split.title, split.artist].filter(Boolean).join(' ')),
    });
    if (rows.length >= limit) break;
  }
  return rows.filter((row) => row.title && row.normalizedKey);
}

function extractWebPlaylistRowsFromContext(webRoomContext, limit = 10, cliRows = []) {
  const roomItems = Array.isArray(webRoomContext?.roomItems) ? webRoomContext.roomItems : [];
  for (const item of roomItems) {
    const rows = parsePlaylistRowsFromTextBlock(item, limit, cliRows);
    if (rows.length) return rows;
  }
  return [];
}


function extractCliQueueRows(queueJson, limit = 10) {
  return (Array.isArray(queueJson?.items) ? queueJson.items : [])
    .slice(0, limit)
    .map((entry, index) => {
      const item = entry?.item || {};
      return {
        index,
        position: entry?.position ?? null,
        title: normalizeWhitespace(item.title || ''),
        artist: normalizeWhitespace(item.artist || ''),
        album: normalizeWhitespace(item.album || ''),
        normalizedKey: normalizeRowText([item.title, item.artist].filter(Boolean).join(' ')),
      };
    })
    .filter((row) => row.title && row.normalizedKey);
}

function compareRowLists(webRows, cliRows, options = {}) {
  const requiredPrefixMatches = Math.max(1, Number(options.requiredPrefixMatches) || 2);
  const scopedWebRows = webRows.slice(0, requiredPrefixMatches);
  const scopedCliRows = cliRows.slice(0, requiredPrefixMatches);

  const cliMap = new Map(scopedCliRows.map((row) => [row.normalizedKey, row]));
  const matchedRows = scopedWebRows
    .map((row) => ({
      web: row,
      cli: cliMap.get(row.normalizedKey) || null,
    }))
    .filter((entry) => entry.cli);

  const webKeys = scopedWebRows.map((row) => row.normalizedKey);
  const cliKeys = scopedCliRows.map((row) => row.normalizedKey);
  const prefixLength = Math.min(webKeys.length, cliKeys.length);
  let prefixMatches = 0;
  for (let i = 0; i < prefixLength; i += 1) {
    if (webKeys[i] === cliKeys[i]) prefixMatches += 1;
  }

  const minMatchCount = Math.min(requiredPrefixMatches, Math.max(1, Math.min(scopedWebRows.length, scopedCliRows.length)));
  return {
    matched: prefixMatches >= minMatchCount && matchedRows.length >= minMatchCount,
    matchedCount: matchedRows.length,
    minMatchCount,
    prefixMatches,
    checkedWebRows: scopedWebRows.length,
    checkedCliRows: scopedCliRows.length,
    matchedRows,
    webRows: scopedWebRows,
    cliRows: scopedCliRows,
    totalWebRows: webRows.length,
    totalCliRows: cliRows.length,
    requiredPrefixMatches,
  };
}

export function verifyMediaPlayback({
  room,
  actionName,
  postStatus,
  followupStatus,
  followupQueueJson,
  retryPlay,
  retrySnapshot,
  selectedType,
  webDetailRows,
  webRoomContext,
}) {
  let effectiveFollowupStatus = followupStatus;
  let effectiveQueueJson = followupQueueJson;

  if (!groupIncludesRoom(postStatus.group, room)) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Target room is not present in the Sonos group reported after playback.', {
      room,
      group: postStatus.group,
    });
  }

  if (String(effectiveFollowupStatus.state || '').toUpperCase() !== 'PLAYING') {
    if (typeof retryPlay === 'function') {
      retryPlay();
      if (typeof retrySnapshot === 'function') {
        const retried = retrySnapshot();
        if (retried?.status) effectiveFollowupStatus = retried.status;
        if (retried?.queueJson) effectiveQueueJson = retried.queueJson;
      }
    }
  }

  const playbackSuccess = String(effectiveFollowupStatus.state || '').toUpperCase() === 'PLAYING';
  if (!playbackSuccess) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'Sonos CLI did not confirm PLAYING after the web action.', {
      room,
      state: effectiveFollowupStatus.state || null,
      title: effectiveFollowupStatus.title || null,
      track: effectiveFollowupStatus.track || null,
      actionName,
    });
  }

  if (selectedType !== 'playlist') {
    return {
      actionName,
      playbackSuccess,
      executionMatched: true,
      matchedBy: 'playing-state-only-non-playlist',
      finalState: effectiveFollowupStatus.state || null,
      finalTitle: effectiveFollowupStatus.title || null,
      finalTrack: effectiveFollowupStatus.track || null,
    };
  }

  const cliRows = extractCliQueueRows(effectiveQueueJson, 10);
  const structuredWebRows = extractWebPlaylistRows(webDetailRows, 10);
  const fallbackWebRows = structuredWebRows.length ? [] : extractWebPlaylistRowsFromContext(webRoomContext, 10, cliRows);
  const webRows = structuredWebRows.length ? structuredWebRows : fallbackWebRows;
  const rowMatch = compareRowLists(webRows, cliRows, { requiredPrefixMatches: 2 });
  const finalTitleKey = normalizeRowText(effectiveFollowupStatus.title || '');
  const selectedFirstRowKey = webRows[0]?.normalizedKey || '';
  const finalTitleMatchesSelection = !!(finalTitleKey && selectedFirstRowKey && (
    selectedFirstRowKey.includes(finalTitleKey) || finalTitleKey.includes(normalizeRowText(webRows[0]?.title || ''))
  ));
  const immediatePlaySuccess = actionName === '立即播放' && finalTitleMatchesSelection;

  if (!rowMatch.matched && !immediatePlaySuccess) {
    throw new SkillError('verify-cli', 'CLI_VERIFY_FAILED', 'CLI queue list does not match the playlist rows shown on the Sonos page.', {
      room,
      actionName,
      playbackSuccess,
      selectedType,
      rowMatch,
      webRowsSource: structuredWebRows.length ? 'detailRows' : 'webRoomContext',
      finalState: effectiveFollowupStatus.state || null,
      finalTitle: effectiveFollowupStatus.title || null,
      finalTrack: effectiveFollowupStatus.track || null,
      finalTitleMatchesSelection,
    });
  }

  return {
    actionName,
    playbackSuccess,
    executionMatched: true,
    matchedBy: rowMatch.matched ? 'playlist-row-list' : 'immediate-play-current-track',
    rowMatch,
    webRowsSource: structuredWebRows.length ? 'detailRows' : 'webRoomContext',
    finalState: effectiveFollowupStatus.state || null,
    finalTitle: effectiveFollowupStatus.title || null,
    finalTrack: effectiveFollowupStatus.track || null,
    finalTitleMatchesSelection,
  };
}
