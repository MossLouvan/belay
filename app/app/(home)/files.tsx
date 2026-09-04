// Files. Browse the host's allowed roots the way Finder would: back/forward/up
// arrows, a breadcrumb path bar with copy, a Go-to-Folder sheet for pasted
// paths, sortable Name/Kind/Size/Date columns with folders leading, and a
// per-row ⋯ (long-press as the shortcut) that surfaces an entry's details.
// Dotfiles are hidden by default behind a persisted "Show hidden" toggle
// (src/files/hidden.ts), with the count line stating what is withheld.
// Read-only by design —
// a phone file manager that can't clobber anything on the PC, and the host
// exposes no write route at all.
//
// The root list is whatever the host reports (Windows gives four, macOS adds
// /Volumes for external drives), so nothing here assumes a fixed set. The
// toolbar, sheet, header, info panel and pure logic live in `src/files/` and
// `src/files-*` — expo-router would turn a helper module under `app/` into a
// fifth tab.
//
// Anatomy (Next Terminal reference): title + mono status line + header rule,
// the roots as ink text-tabs (selection is the 2pt underline), the path in
// the machine's mono voice, and the listing as a flush Card of
// hairline-divided 52pt data rows under its sort-header row — the screen's
// one blue accent is the active sort column. Reloading is pull-to-refresh
// plus the "Go to" and root controls; a labelled Retry appears in the banner
// when a read has failed.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { SwitchComputerLink } from '../../src/devices/switch-link';
import { api } from '../../src/api';
import type { FileEntry } from '../../src/api';
import { Banner, Card, Divider, EmptyState, Input, Label, Row, Rule, Skeleton, TrackLabel, Txt } from '../../src/ui';
import { useTheme } from '../../src/theme';
import { crumbsFor, formatAsOf, isDenied, messageOf, parentOf, sortEntries, viewerKindOf } from '../../src/files-format';
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
import { hiddenCount, toggledHiddenMode, withoutHidden } from '../../src/files/hidden';
import type { HiddenMode } from '../../src/files/hidden';
import { loadHiddenMode, persistHiddenMode } from '../../src/files/hidden-store';
import { ToolPanel } from '../../src/home/panel';

// --- constants ---------------------------------------------------------------

const SKELETON_ROWS = 8;

interface Root {
  readonly name: string;
  readonly path: string;
}

// --- screen ------------------------------------------------------------------

/** The panel route: the unchanged tab body inside the shared slide-up chrome. */
export default function FilesPanel() {
  return (
    <ToolPanel testID="files-panel">
      <FilesTab />
    </ToolPanel>
  );
}

function FilesTab() {
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
  const [hiddenMode, setHiddenMode] = useState<HiddenMode>('hide');
  const [now, setNow] = useState(() => Date.now());

  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  // The show-hidden choice outlives the session (hidden-store.ts): someone
  // who works in dotfiles works in them every launch, and re-hiding on each
  // open would make the toggle feel broken.
  useEffect(() => {
    void loadHiddenMode().then((mode) => {
      if (!cancelled.current) setHiddenMode(mode);
    });
  }, []);

  const toggleHidden = useCallback(() => {
    setHiddenMode((mode) => {
      const next = toggledHiddenMode(mode);
      void persistHiddenMode(next);
      return next;
    });
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
    const shown = hiddenMode === 'hide' ? withoutHidden(entries) : entries;
    const needle = query.trim().toLowerCase();
    const filtered = needle ? shown.filter((e) => e.name.toLowerCase().includes(needle)) : shown;
    return sortEntries(filtered, sortKey, descending);
  }, [descending, entries, hiddenMode, query, sortKey]);

  const folderCount = useMemo(() => visible.filter((e) => e.dir).length, [visible]);
  const hiddenN = useMemo(() => hiddenCount(entries), [entries]);
  const renderItem = useCallback(
    ({ item }: { item: FileEntry }) => (
      <FileRow
        entry={item}
        now={now}
        selected={selected?.path === item.path}
        onPress={openEntry}
        onLongPress={toggleSelect}
        onInfo={toggleSelect}
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
          {/* Quiet tracked labels, not accent: this screen's one accented
              selection is the active root, and these occasional verbs must not
              dilute it (docs/DESIGN.md §3.3). The resting track says tappable.
              The hidden toggle states the *action*, so its label flips with
              the mode; the count line below carries the "· N hidden" receipt. */}
          <Row gap="lg" align="flex-end">
            <TrackLabel
              testID="files-hidden-toggle"
              label={hiddenMode === 'hide' ? 'Show hidden' : 'Hide hidden'}
              accessibilityLabel={hiddenMode === 'hide' ? 'Show hidden files' : 'Hide hidden files'}
              accessibilityHint="Files whose names start with a dot"
              onPress={toggleHidden}
              hitSlop={theme.layout.hitSlop}
            />
            <TrackLabel
              testID="files-goto"
              label="Go to…"
              accessibilityLabel="Go to a folder path"
              accessibilityHint="Type or paste an absolute path"
              onPress={() => setGotoOpen(true)}
              hitSlop={theme.layout.hitSlop}
            />
          </Row>
        </Row>
        {/* The freshness stamp lives up here in the fixed header — visible
            before the need arises, proving the listing's age and implying
            pull-to-refresh — not in a footer nobody scrolls to (§11.2). */}
        <Row justify="space-between" gap="sm" style={{ marginTop: theme.space.xxs }}>
          <Label numberOfLines={1} style={{ marginBottom: 0, flexShrink: 1 }}>
            {[
              `${visible.length} item${visible.length === 1 ? '' : 's'} · ${folderCount} folder${folderCount === 1 ? '' : 's'}`,
              // The count line owns the honesty: while dotfiles are filtered
              // out, it says how many, so a "missing" file is one glance from
              // its explanation — and the toggle sits right beside the number.
              hiddenMode === 'hide' && hiddenN > 0 ? `${hiddenN} hidden` : '',
              formatAsOf(now),
            ]
              .filter(Boolean)
              .join(' · ')}
          </Label>
          <SwitchComputerLink />
        </Row>
      </View>
      <Rule style={{ marginTop: theme.space.sm }} />

      {/* The allowed roots as text-tabs: the selection IS the 2pt underline. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ paddingHorizontal: margin, gap: theme.space.md }}
      >
        {/* Every root carries the resting track (docs/DESIGN.md §11.1): the
            unselected ones must look pressable too, or the strip is
            indistinguishable from the inert count line two lines up. The
            active root is marked in INK — label and track — not accent: this
            screen spends blue exactly once, on the active sort column. */}
        {roots.map((root) => (
          <TrackLabel
            key={root.path}
            testID={`root-${root.name}`}
            label={root.name}
            accessibilityLabel={`Open ${root.name}`}
            active={path === root.path}
            inks={{ activeLabel: theme.colors.text, activeTrack: theme.colors.text }}
            onPress={() => openDir(root.path)}
          />
        ))}
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

      {/* The listing is the reference's table: one flush Card whose
          hairline-divided rows carry the data, with the sort header as the
          card's own column row. */}
      <Card flush style={{ flex: 1, marginHorizontal: margin, marginBottom: theme.space.md, overflow: 'hidden' }}>
        <SortHeader sortKey={sortKey} descending={descending} onChange={onSort} />
        {loading && !refreshing ? (
          <View style={{ paddingHorizontal: theme.space.md }}>
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <View key={i}>
                <Row justify="space-between" gap="sm" style={{ minHeight: theme.layout.rowHeight }}>
                  <Skeleton width={`${45 + ((i * 7) % 35)}%`} height={13} />
                  <Skeleton width="22%" height={11} />
                </Row>
                {i < SKELETON_ROWS - 1 ? <Divider inset={-theme.space.md} /> : null}
              </View>
            ))}
          </View>
        ) : (
          <FlatList
            testID="file-list"
            data={visible}
            renderItem={renderItem}
            keyExtractor={(item) => item.path}
            ItemSeparatorComponent={Divider}
            contentContainerStyle={{ paddingBottom: theme.space.xs, flexGrow: 1 }}
            // "handled" stays: the default swallows the first tap on every row
            // while the filter keyboard is up. The interactive dismiss gives the
            // drag-away exit — tap-outside here navigates into a folder, so the
            // scroll gesture is the only non-destructive one (§11.2).
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
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
                  style={{ paddingHorizontal: theme.space.md }}
                />
              ) : hiddenMode === 'hide' && hiddenN > 0 ? (
                // Everything here is a dotfile. A bare "empty" would be a lie —
                // say what is being withheld and hand over the one action that
                // reveals it.
                <EmptyState
                  testID="files-all-hidden"
                  title="Only hidden items here"
                  message={`This folder holds ${hiddenN} hidden item${hiddenN === 1 ? '' : 's'} and nothing else.`}
                  action={{ label: 'Show hidden', onPress: toggleHidden }}
                  style={{ paddingHorizontal: theme.space.md }}
                />
              ) : (
                <EmptyState
                  testID="files-empty"
                  title="This folder is empty"
                  message="There is nothing here to open."
                  style={{ paddingHorizontal: theme.space.md }}
                />
              )
            }
          />
        )}
      </Card>

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
