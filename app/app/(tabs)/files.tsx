// Files. Browse the host's allowed roots the way Finder would: back/forward/up
// arrows, a breadcrumb path bar with copy, a Go-to-Folder sheet for pasted
// paths, sortable Name/Kind/Size/Date columns with folders leading, and a
// long-press selection that surfaces an entry's details. Read-only by design —
// a phone file manager that can't clobber anything on the PC, and the host
// exposes no write route at all.
//
// The root list is whatever the host reports (Windows gives four, macOS adds
// /Volumes for external drives), so nothing here assumes a fixed set. The
// toolbar, sheet, header, info panel and pure logic live in `src/files/` and
// `src/files-*` — expo-router would turn a helper module under `app/` into a
// fifth tab.
//
// Ledger anatomy: title + mono status line + header rule, the roots as label
// text-tabs (selection is the 2pt underline), the path in the machine's mono
// voice, and the list as hairline-separated 52pt rows. Reloading is
// pull-to-refresh plus the "Go to" and root controls; a labelled Retry
// appears in the banner when a read has failed.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api } from '../../src/api';
import type { FileEntry } from '../../src/api';
import { Banner, EmptyState, Input, Label, Micro, Row, Rule, Skeleton, Txt, haptic } from '../../src/ui';
import { useTheme } from '../../src/theme';
import { crumbsFor, isDenied, messageOf, parentOf, sortEntries, viewerKindOf } from '../../src/files-format';
import type { SortKey } from '../../src/files-format';
import { FileRow } from '../../src/files-row';
import { FileViewer } from '../../src/files-viewer';
import type { OpenFile } from '../../src/files-viewer';
import { canGoBack, canGoForward, currentPath, emptyHistory, goBack, goForward, visitPath } from '../../src/files/history';
import type { NavHistory } from '../../src/files/history';
import { PathBar } from '../../src/files/path-bar';
import { GoToSheet } from '../../src/files/go-to-sheet';
import { SortHeader } from '../../src/files/sort-header';
import { InfoCard } from '../../src/files/info-card';

// --- constants ---------------------------------------------------------------

const SKELETON_ROWS = 8;

interface Root {
  readonly name: string;
  readonly path: string;
}

// --- screen ------------------------------------------------------------------

export default function FilesTab() {
  const { connection } = useConnection();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [roots, setRoots] = useState<readonly Root[]>([]);
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<readonly FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [descending, setDescending] = useState(false);
  const [viewer, setViewer] = useState<OpenFile | null>(null);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [history, setHistory] = useState<NavHistory>(emptyHistory);
  const [gotoOpen, setGotoOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  /**
   * Load a directory, or throw. The history records the *resolved* path the
   * host answers with, not the one asked for — the host realpath's symlinks,
   * and recording the request would make Back revisit a path that renders as
   * somewhere else, breaking the dedupe that keeps the stack sane.
   */
  const loadDir = useCallback(async (target: string, record: boolean): Promise<void> => {
    setLoading(true);
    setSelected(null);
    try {
      const result = await api.listDir(target);
      if (cancelled.current) return;
      setPath(result.path);
      setEntries(result.entries);
      setError('');
      setQuery('');
      setNow(Date.now());
      if (record) setHistory((h) => visitPath(h, result.path));
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

  /** The forgiving wrapper for taps: failures land in the banner, not a throw. */
  const openDir = useCallback(
    (target: string, record = true) =>
      loadDir(target, record).catch((e: unknown) => {
        if (cancelled.current) return;
        setError(messageOf(e));
        setEntries([]);
      }),
    [loadDir]
  );

  useEffect(() => {
    if (!connection) return;
    setLoading(true);
    api
      .fileRoots()
      .then((result) => {
        if (cancelled.current) return;
        setRoots(result.roots);
        if (result.roots.length > 0) return openDir(result.roots[0].path);
        setLoading(false);
        return undefined;
      })
      .catch((e: unknown) => {
        if (cancelled.current) return;
        setError(messageOf(e));
        setLoading(false);
      });
  }, [connection, openDir]);

  const openEntry = useCallback(
    async (entry: FileEntry) => {
      if (entry.dir) {
        await openDir(entry.path);
        return;
      }
      setError('');
      const kind = viewerKindOf(entry.name);
      // Only text-shaped kinds are fetched here, up front, so a read failure
      // lands in the banner. Images and PDFs fetch their own bytes inside the
      // viewer (they need the raw route, not the JSON one), and a known binary
      // format opens straight onto its "no preview" notice with nothing moved.
      if (kind !== 'text' && kind !== 'markdown') {
        setViewer({ name: entry.name, path: entry.path, size: entry.size, kind });
        return;
      }
      try {
        const file = await api.readFile(entry.path);
        if (cancelled.current) return;
        setViewer({
          name: file.name,
          path: file.path,
          content: file.content,
          truncated: file.truncated,
          size: file.size,
          kind,
        });
      } catch (e: unknown) {
        if (!cancelled.current) setError(messageOf(e));
      }
    },
    [openDir]
  );

  // Back/forward commit the cursor move first and then load without recording;
  // recording the arrival would push a duplicate and eat the forward trail.
  const back = useCallback(() => {
    const moved = goBack(history);
    const target = currentPath(moved);
    if (moved === history || !target) return;
    setHistory(moved);
    openDir(target, false);
  }, [history, openDir]);

  const forward = useCallback(() => {
    const moved = goForward(history);
    const target = currentPath(moved);
    if (moved === history || !target) return;
    setHistory(moved);
    openDir(target, false);
  }, [history, openDir]);

  // Long-press selects; long-pressing the selected row again deselects, so the
  // gesture is its own undo and no extra chrome is needed to clear it.
  const toggleSelect = useCallback((entry: FileEntry) => {
    setSelected((current) => (current?.path === entry.path ? null : entry));
  }, []);

  const onSort = useCallback((key: SortKey, desc: boolean) => {
    setSortKey(key);
    setDescending(desc);
  }, []);

  const pullToRefresh = useCallback(async () => {
    if (!path) return;
    setRefreshing(true);
    await openDir(path, false);
    if (!cancelled.current) setRefreshing(false);
  }, [openDir, path]);

  const crumbs = useMemo(() => crumbsFor(path), [path]);
  const parent = useMemo(() => parentOf(path), [path]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
    return sortEntries(filtered, sortKey, descending);
  }, [descending, entries, query, sortKey]);

  const folderCount = useMemo(() => visible.filter((e) => e.dir).length, [visible]);
  const renderItem = useCallback(
    ({ item }: { item: FileEntry }) => (
      <FileRow
        entry={item}
        now={now}
        selected={selected?.path === item.path}
        onPress={openEntry}
        onLongPress={toggleSelect}
      />
    ),
    [now, openEntry, selected, toggleSelect]
  );

  if (viewer) return <FileViewer file={viewer} onClose={() => setViewer(null)} />;

  const denied = isDenied(error);
  const margin = theme.layout.margin;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top + theme.space.md }}>
      <View style={{ paddingHorizontal: margin }}>
        <Row justify="space-between" align="flex-end" gap="sm">
          <Txt variant="title" heading>
            Files
          </Txt>
          <Pressable
            testID="files-goto"
            accessibilityRole="button"
            accessibilityLabel="Go to a folder path"
            accessibilityHint="Type or paste an absolute path"
            onPress={() => setGotoOpen(true)}
            hitSlop={theme.layout.hitSlop}
            style={({ pressed }) => ({
              minHeight: theme.space.xl,
              justifyContent: 'center',
              opacity: pressed ? theme.motion.pressOpacity : 1,
            })}
          >
            <Label tone="accent" style={{ marginBottom: 0 }}>Go to…</Label>
          </Pressable>
        </Row>
        <Label style={{ marginTop: theme.space.xxs, marginBottom: 0 }}>
          {`${visible.length} item${visible.length === 1 ? '' : 's'} · ${folderCount} folder${folderCount === 1 ? '' : 's'}`}
        </Label>
      </View>
      <Rule style={{ marginTop: theme.space.sm }} />

      {/* The allowed roots as text-tabs: the selection IS the 2pt underline. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ paddingHorizontal: margin, gap: theme.space.md }}
      >
        {roots.map((root) => {
          const active = path === root.path;
          return (
            <Pressable
              key={root.path}
              testID={`root-${root.name}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Open ${root.name}`}
              onPress={() => {
                haptic('light');
                openDir(root.path);
              }}
              style={({ pressed }) => ({
                minHeight: theme.layout.minTouch,
                justifyContent: 'center',
                opacity: pressed ? theme.motion.pressOpacity : 1,
              })}
            >
              <Label tone={active ? 'accent' : 'dim'} style={{ marginBottom: 0 }}>
                {root.name}
              </Label>
              <View
                accessibilityElementsHidden
                style={{
                  height: theme.layout.ruleEmphasis,
                  marginTop: theme.space.xxs,
                  backgroundColor: active ? theme.colors.accentGraphic : 'transparent',
                }}
              />
            </Pressable>
          );
        })}
      </ScrollView>

      <PathBar
        path={path}
        crumbs={crumbs}
        canBack={canGoBack(history)}
        canForward={canGoForward(history)}
        canUp={parent !== null}
        onBack={back}
        onForward={forward}
        onUp={() => parent && openDir(parent)}
        onNavigate={openDir}
      />

      <View style={{ paddingHorizontal: margin, paddingBottom: theme.space.xs }}>
        <Input
          testID="files-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Filter this folder…"
          accessibilityLabel="Filter this folder"
        />
      </View>

      <SortHeader sortKey={sortKey} descending={descending} onChange={onSort} />

      {error ? (
        <Banner
          testID="files-error"
          status={denied ? 'warn' : 'bad'}
          title={denied ? 'The host would not open that' : 'Could not read the host'}
          message={
            denied
              ? `${error}. That path is outside the folders the agent is allowed to read, or the OS refused access.`
              : error
          }
          action={path ? { label: 'Retry', onPress: () => openDir(path) } : undefined}
          style={{ marginHorizontal: margin, marginVertical: theme.space.xs }}
        />
      ) : null}

      {loading && !refreshing ? (
        <View style={{ paddingHorizontal: margin }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <View key={i}>
              <Row justify="space-between" gap="sm" style={{ minHeight: theme.layout.rowHeight }}>
                <Skeleton width={`${45 + ((i * 7) % 35)}%`} height={13} />
                <Skeleton width="22%" height={11} />
              </Row>
              <Rule bleed={margin} />
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          testID="file-list"
          data={visible}
          renderItem={renderItem}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{ paddingHorizontal: margin, paddingBottom: theme.space.lg, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={16}
          extraData={selected}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void pullToRefresh()} tintColor={theme.colors.accent} />
          }
          ListEmptyComponent={
            error ? null : query ? (
              <EmptyState
                testID="files-no-match"
                title="Nothing matches"
                message={`No item in this folder contains “${query.trim()}”.`}
                action={{ label: 'Clear the filter', onPress: () => setQuery('') }}
              />
            ) : (
              <EmptyState testID="files-empty" title="This folder is empty" message="There is nothing here to open." />
            )
          }
          ListFooterComponent={
            visible.length > 0 ? (
              <Micro style={{ marginTop: theme.space.sm }}>Pull down to reload · long-press a row for details</Micro>
            ) : null
          }
        />
      )}

      {selected ? <InfoCard entry={selected} now={now} onClose={() => setSelected(null)} /> : null}

      <GoToSheet
        visible={gotoOpen}
        roots={roots}
        onClose={() => setGotoOpen(false)}
        onNavigate={(target) => loadDir(target, true)}
      />
    </View>
  );
}
