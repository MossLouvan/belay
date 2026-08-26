// Files. Browse the host's allowed roots, tap into folders, and open text files
// in a viewer. Read-only by design — a phone file manager that can't clobber
// anything on the PC, and the host exposes no write route at all.
//
// The root list is whatever the host reports (Windows gives four, macOS adds
// /Volumes for external drives), so nothing here assumes a fixed set. The row,
// the viewer and the pure formatting helpers live in `src/files-*` — expo-router
// would turn a helper module under `app/` into a fifth tab.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, FileEntry } from '../../src/api';
import {
  Badge,
  Banner,
  Caption,
  EmptyState,
  IconButton,
  Input,
  Row,
  SegmentedControl,
  Skeleton,
  Txt,
  haptic,
} from '../../src/ui';
import { useTheme } from '../../src/theme';
import { crumbsFor, isDenied, messageOf, parentOf, sortEntries } from '../../src/files-format';
import type { SortKey } from '../../src/files-format';
import { FileRow } from '../../src/files-row';
import { FileViewer } from '../../src/files-viewer';
import type { OpenFile } from '../../src/files-viewer';

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
  const [now, setNow] = useState(() => Date.now());

  const crumbScroll = useRef<ScrollView>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const openDir = useCallback(async (target: string) => {
    setLoading(true);
    setError('');
    try {
      const result = await api.listDir(target);
      if (cancelled.current) return;
      setPath(result.path);
      setEntries(result.entries);
      setNow(Date.now());
    } catch (e: unknown) {
      if (cancelled.current) return;
      setError(messageOf(e));
      setEntries([]);
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, []);

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
        setQuery('');
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

  const crumbs = useMemo(() => crumbsFor(path), [path]);
  const parent = useMemo(() => parentOf(path), [path]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
    return sortEntries(filtered, sortKey, descending);
  }, [descending, entries, query, sortKey]);

  const folderCount = useMemo(() => visible.filter((e) => e.dir).length, [visible]);
  const renderItem = useCallback(
    ({ item }: { item: FileEntry }) => <FileRow entry={item} now={now} onPress={openEntry} />,
    [now, openEntry]
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

      {/* flexGrow/flexShrink are pinned: a horizontal ScrollView in a flex
          column otherwise collapses to nothing once the list below overflows. */}
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
                setQuery('');
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

      <Row gap="xs" style={{ paddingHorizontal: theme.space.sm, paddingBottom: theme.space.xs }}>
        <IconButton
          testID="files-up"
          accessibilityLabel="Go to the parent folder"
          disabled={!parent}
          onPress={() => parent && openDir(parent)}
          size={38}
        >
          <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 16, fontWeight: '800' }}>
            ↑
          </Text>
        </IconButton>
        <ScrollView
          ref={crumbScroll}
          horizontal
          showsHorizontalScrollIndicator={false}
          onContentSizeChange={() => crumbScroll.current?.scrollToEnd({ animated: false })}
          contentContainerStyle={{ alignItems: 'center', gap: 2, paddingRight: theme.space.sm }}
          style={{ flex: 1 }}
        >
          {crumbs.length === 0 ? <Caption>—</Caption> : null}
          {crumbs.map((crumb, index) => (
            <Row key={crumb.path} gap="none">
              {index > 0 ? (
                <Text allowFontScaling={false} style={{ color: theme.colors.textFaint, fontSize: 13 }}>
                  ›
                </Text>
              ) : null}
              <Pressable
                testID={`crumb-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Go to ${crumb.label}`}
                onPress={() => openDir(crumb.path)}
                hitSlop={theme.layout.hitSlop}
                style={({ pressed }) => ({ paddingHorizontal: 6, paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}
              >
                <Txt
                  variant="monoSmall"
                  color={index === crumbs.length - 1 ? theme.colors.text : theme.colors.textDim}
                  style={{ fontWeight: index === crumbs.length - 1 ? '700' : '400' }}
                >
                  {crumb.label}
                </Txt>
              </Pressable>
            </Row>
          ))}
        </ScrollView>
      </Row>

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

      <Row gap="sm" style={{ paddingHorizontal: theme.space.sm, paddingBottom: theme.space.xs }}>
        <SegmentedControl
          testID="files-sort"
          accessibilityLabel="Sort by"
          options={[{ value: 'name', label: 'Name' }, { value: 'size', label: 'Size' }, { value: 'date', label: 'Date' }]}
          value={sortKey}
          onChange={setSortKey}
          style={{ flex: 1 }}
        />
        <IconButton
          testID="files-sort-dir"
          accessibilityLabel={descending ? 'Sort ascending' : 'Sort descending'}
          accessibilityHint="Reverses the current sort order"
          onPress={() => setDescending((v) => !v)}
          size={38}
        >
          <Text allowFontScaling={false} style={{ color: theme.colors.text, fontSize: 15, fontWeight: '800' }}>
            {descending ? '↓' : '↑'}
          </Text>
        </IconButton>
      </Row>

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
    </View>
  );
}
