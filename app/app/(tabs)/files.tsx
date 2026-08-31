// Files. Browse the host's allowed roots the way Finder would: back/forward/up
// arrows, a breadcrumb path bar with copy, a Go-to-Folder sheet for pasted
// paths, sortable Name/Kind/Size/Date columns with folders leading, and a
// long-press selection that surfaces an entry's details. Read-only by design —
// a phone file manager that can't clobber anything on the PC, and the host
// exposes no write route at all.
//
// The root list is whatever the host reports (Windows gives four, macOS adds
// /Volumes for external drives), so nothing here assumes a fixed set. The
// toolbar, sheet, header, info card and pure logic live in `src/files/` and
// `src/files-*` — expo-router would turn a helper module under `app/` into a
// fifth tab.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, FileEntry } from '../../src/api';
import { Badge, Banner, EmptyState, IconButton, Input, Row, Skeleton, Txt, haptic } from '../../src/ui';
import { useTheme } from '../../src/theme';
import { crumbsFor, isDenied, messageOf, parentOf, sortEntries } from '../../src/files-format';
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
      try {
        const file = await api.readFile(entry.path);
        if (cancelled.current) return;
        setViewer({
          name: file.name,
          path: file.path,
          content: file.content,
          truncated: file.truncated,
          size: file.size,
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

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: insets.top }}>
      <Row justify="space-between" gap="sm" style={{ paddingHorizontal: theme.space.md, paddingBottom: theme.space.xs }}>
        <Txt variant="subheading" heading>
          Files
        </Txt>
        <Row gap="xs">
          <Badge
            label={`${visible.length} item${visible.length === 1 ? '' : 's'}`}
            status={folderCount > 0 ? 'accent' : 'neutral'}
          />
          <IconButton
            testID="files-goto"
            accessibilityLabel="Go to a folder path"
            accessibilityHint="Type or paste an absolute path"
            onPress={() => setGotoOpen(true)}
            size={38}
          >
            <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>
              ⌁
            </Text>
          </IconButton>
          <IconButton
            testID="files-refresh"
            accessibilityLabel="Reload this folder"
            onPress={() => path && openDir(path)}
            size={38}
          >
            <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 16, fontWeight: '800' }}>
              ⟳
            </Text>
          </IconButton>
        </Row>
      </Row>

      {/* Finder's sidebar, phone-sized: the allowed roots as chips. flexGrow/
          flexShrink are pinned — a horizontal ScrollView in a flex column
          otherwise collapses to nothing once the list below overflows. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={{ alignItems: 'center', gap: 6, paddingHorizontal: theme.space.sm, paddingBottom: theme.space.xs }}
      >
        {roots.map((root) => {
          const active = path === root.path;
          return (
            <Pressable
              key={root.path}
              testID={`root-${root.name}`}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => {
                haptic('light');
                openDir(root.path);
              }}
              style={({ pressed }) => ({
                minHeight: 36,
                justifyContent: 'center',
                paddingHorizontal: theme.space.md,
                borderRadius: theme.radius.pill,
                borderWidth: theme.layout.hairline,
                borderColor: active ? theme.colors.accent : theme.colors.borderStrong,
                backgroundColor: active ? theme.colors.accentSoft : theme.colors.surfaceAlt,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Txt variant="caption" color={active ? theme.colors.onAccentSoft : theme.colors.textDim} style={{ fontWeight: '700' }}>
                {root.name}
              </Txt>
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

      <Row gap="sm" style={{ paddingHorizontal: theme.space.sm, paddingBottom: theme.space.xs }}>
        <Input
          testID="files-search"
          value={query}
          onChangeText={setQuery}
          placeholder="Filter this folder…"
          accessibilityLabel="Filter this folder"
          style={{ flex: 1 }}
        />
      </Row>

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
          action={path ? { label: 'Try again', onPress: () => openDir(path) } : undefined}
          style={{ marginHorizontal: theme.space.sm, marginBottom: theme.space.xs }}
        />
      ) : null}

      {loading ? (
        <View style={{ paddingHorizontal: theme.space.md, gap: theme.space.md, paddingTop: theme.space.sm }}>
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <Row key={i} gap="sm">
              <Skeleton width={30} height={26} radius={theme.radius.sm} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={`${55 + ((i * 7) % 35)}%`} height={13} />
                <Skeleton width="30%" height={10} />
              </View>
            </Row>
          ))}
        </View>
      ) : (
        <FlatList
          testID="file-list"
          data={visible}
          renderItem={renderItem}
          keyExtractor={(item) => item.path}
          contentContainerStyle={{ paddingHorizontal: theme.space.xs, paddingBottom: theme.space.lg, flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={16}
          extraData={selected}
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
