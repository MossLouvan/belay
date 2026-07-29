// Files. Browse the host's allowed roots, tap into folders, and open text files
// in a viewer. Read-only by design — a phone file manager that can't clobber
// anything on the PC.

import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useConnection } from '../../src/connection';
import { api, FileEntry } from '../../src/api';
import { Row } from '../../src/ui';
import { colors, radius, space, font } from '../../src/theme';

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export default function FilesTab() {
  const { connection } = useConnection();
  const insets = useSafeAreaInsets();
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([]);
  const [path, setPath] = useState<string>('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [viewer, setViewer] = useState<{ name: string; content: string; truncated: boolean } | null>(null);

  useEffect(() => {
    if (!connection) return;
    api.fileRoots().then((r) => {
      setRoots(r.roots);
      if (r.roots[0]) open(r.roots[0].path);
    }).catch((e) => setError(e.message));
  }, [connection]);

  const open = useCallback(async (p: string) => {
    setLoading(true); setError('');
    try {
      const res = await api.listDir(p);
      setPath(res.path);
      setEntries(res.entries);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const openEntry = async (entry: FileEntry) => {
    if (entry.dir) { open(entry.path); return; }
    try {
      const f = await api.readFile(entry.path);
      setViewer({ name: f.name, content: f.content, truncated: f.truncated });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const goUp = () => {
    const parent = path.replace(/[\\/]+[^\\/]+[\\/]*$/, '');
    if (parent && parent.length >= 2) open(parent);
  };

  if (viewer) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
        <Row style={{ justifyContent: 'space-between', paddingHorizontal: space.md, paddingVertical: space.sm }}>
          <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '700', fontSize: 16, flex: 1 }}>{viewer.name}</Text>
          <Pressable testID="viewer-close" onPress={() => setViewer(null)} style={{ paddingHorizontal: space.md, paddingVertical: 6, backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.borderStrong }}>
            <Text style={{ color: colors.text, fontWeight: '700' }}>Close</Text>
          </Pressable>
        </Row>
        <ScrollView style={{ flex: 1, backgroundColor: colors.black, marginHorizontal: space.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }} contentContainerStyle={{ padding: space.sm }}>
          <Text selectable style={{ color: colors.text, fontFamily: font.mono, fontSize: 12.5, lineHeight: 18 }}>{viewer.content}</Text>
          {viewer.truncated && <Text style={{ color: colors.warn, marginTop: space.md, fontSize: 12 }}>— truncated at 512 KB —</Text>}
        </ScrollView>
        <View style={{ height: insets.bottom + space.sm }} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg, paddingTop: insets.top }}>
      <Text style={{ color: colors.text, fontWeight: '700', fontSize: 16, paddingHorizontal: space.md, paddingBottom: space.sm }}>Files</Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space.sm, paddingBottom: space.sm }}>
        {roots.map((r) => (
          <Pressable key={r.path} testID={`root-${r.name}`} onPress={() => open(r.path)} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7, borderWidth: 1, borderColor: colors.borderStrong }}>
            <Text style={{ color: colors.text, fontWeight: '700', fontSize: 13 }}>{r.name}</Text>
          </Pressable>
        ))}
      </View>

      <Row style={{ paddingHorizontal: space.sm, paddingBottom: space.sm, gap: space.sm }}>
        <Pressable testID="files-up" onPress={goUp} style={{ backgroundColor: colors.surfaceAlt, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8, borderWidth: 1, borderColor: colors.borderStrong }}>
          <Text style={{ color: colors.text, fontWeight: '700' }}>↑ Up</Text>
        </Pressable>
        <View style={{ flex: 1, backgroundColor: colors.surface, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, justifyContent: 'center' }}>
          <Text numberOfLines={1} ellipsizeMode="head" style={{ color: colors.textDim, fontFamily: font.mono, fontSize: 12 }}>{path || '—'}</Text>
        </View>
      </Row>

      {!!error && (
        <View style={{ marginHorizontal: space.sm, marginBottom: space.sm, backgroundColor: '#2a161a', borderRadius: radius.sm, padding: space.sm, borderWidth: 1, borderColor: '#5c2a30' }}>
          <Text style={{ color: colors.bad, fontSize: 13 }}>{error}</Text>
        </View>
      )}

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <FlatList
          testID="file-list"
          data={entries}
          keyExtractor={(e) => e.path}
          contentContainerStyle={{ paddingHorizontal: space.sm, paddingBottom: insets.bottom + space.md }}
          ListEmptyComponent={<Text style={{ color: colors.textFaint, textAlign: 'center', marginTop: space.xl }}>Empty folder</Text>}
          renderItem={({ item }) => (
            <Pressable
              testID={`entry-${item.name}`}
              onPress={() => openEntry(item)}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: space.sm,
                paddingVertical: 11, paddingHorizontal: space.sm,
                borderBottomWidth: 1, borderBottomColor: colors.border,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <FileGlyph dir={item.dir} />
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 15, flex: 1 }}>{item.name}</Text>
              <Text style={{ color: colors.textFaint, fontSize: 12 }}>{item.dir ? '' : fmtSize(item.size)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function FileGlyph({ dir }: { dir: boolean }) {
  if (dir) {
    return <View style={{ width: 20, height: 15, borderRadius: 3, backgroundColor: colors.accentDim, borderWidth: 1, borderColor: colors.accent }} />;
  }
  return <View style={{ width: 16, height: 20, borderRadius: 2, backgroundColor: colors.surfaceAlt, borderWidth: 1, borderColor: colors.borderStrong }} />;
}
