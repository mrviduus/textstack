import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as React from 'react';
import { AppState, useColorScheme } from 'react-native';
import { WebView } from 'react-native-webview';

import {
  ActivityIndicator,
  Button,
  FocusAwareStatusBar,
  Text,
  View,
} from '@/components/ui';
import { useAuthStore } from '@/features/auth/use-auth-store';
import { useBook } from '@/features/feed/api';
import Env from 'env';

import { useChapter, useUpsertProgress } from './api';

function buildHtml(body: string, isDark: boolean): string {
  const apiBase = Env.EXPO_PUBLIC_API_URL;
  // Rewrite relative image paths to absolute API URLs
  const html = body.replace(
    /src="\/books\//g,
    `src="${apiBase}/storage/books/`,
  );

  const bg = isDark ? '#111' : '#fff';
  const fg = isDark ? '#e5e5e5' : '#1a1a1a';

  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>
  * { box-sizing: border-box; }
  body {
    font-family: Georgia, serif;
    font-size: 18px;
    line-height: 1.7;
    padding: 16px;
    margin: 0;
    color: ${fg};
    background: ${bg};
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  h1, h2, h3 { line-height: 1.3; }
  a { color: ${isDark ? '#93c5fd' : '#2563eb'}; }
</style>
</head><body>${html}</body></html>`;
}

export function ChapterReaderScreen() {
  const { id, chapter } = useLocalSearchParams<{
    id: string;
    chapter: string;
  }>();
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const user = useAuthStore.use.user();

  const { data, isPending, isError } = useChapter({
    variables: { bookSlug: id, chapterSlug: chapter },
  });

  // Get book detail for edition ID and chapter ID mapping
  const { data: book } = useBook({ variables: { slug: id } });

  const upsertProgress = useUpsertProgress();

  // Save progress when chapter loads and on app background
  const progressSaved = React.useRef(false);
  React.useEffect(() => {
    if (!user || !book || !data || progressSaved.current) return;

    const chapterInfo = book.chapters.find((c) => c.slug === chapter);
    if (!chapterInfo) return;

    const percent =
      book.chapters.length > 0
        ? ((chapterInfo.chapterNumber) / book.chapters.length) * 100
        : null;

    upsertProgress.mutate({
      editionId: book.id,
      data: {
        chapterId: chapterInfo.id,
        locator: chapter,
        percent,
      },
    });
    progressSaved.current = true;
  }, [user, book, data, chapter]);

  // Also save on app background
  React.useEffect(() => {
    if (!user || !book) return;

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        const chapterInfo = book.chapters.find((c) => c.slug === chapter);
        if (!chapterInfo) return;

        const percent =
          book.chapters.length > 0
            ? ((chapterInfo.chapterNumber) / book.chapters.length) * 100
            : null;

        upsertProgress.mutate({
          editionId: book.id,
          data: {
            chapterId: chapterInfo.id,
            locator: chapter,
            percent,
          },
        });
      }
    });

    return () => sub.remove();
  }, [user, book, chapter]);

  // Reset ref when chapter changes
  React.useEffect(() => {
    progressSaved.current = false;
  }, [chapter]);

  if (isPending) {
    return (
      <View className="flex-1 justify-center p-3">
        <Stack.Screen options={{ title: 'Loading…', headerBackTitle: 'Back' }} />
        <FocusAwareStatusBar />
        <ActivityIndicator />
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View className="flex-1 justify-center p-3">
        <Stack.Screen options={{ title: 'Error', headerBackTitle: 'Back' }} />
        <FocusAwareStatusBar />
        <Text className="text-center">Error loading chapter</Text>
      </View>
    );
  }

  const htmlContent = buildHtml(data.html, isDark);

  const goToChapter = (slug: string) => {
    router.replace(`/feed/${id}/${slug}`);
  };

  // Calculate progress for display
  const chapterInfo = book?.chapters.find((c) => c.slug === chapter);
  const progressPercent =
    book && chapterInfo
      ? Math.round((chapterInfo.chapterNumber / book.chapters.length) * 100)
      : null;

  return (
    <View className="flex-1">
      <Stack.Screen
        options={{ title: data.title, headerBackTitle: 'Back' }}
      />
      <FocusAwareStatusBar />

      {progressPercent !== null ? (
        <View className="h-0.5 bg-neutral-200 dark:bg-neutral-700">
          <View
            className="h-full bg-blue-500"
            style={{ width: `${progressPercent}%` }}
          />
        </View>
      ) : null}

      <WebView
        source={{ html: htmlContent }}
        className="flex-1"
        originWhitelist={['*']}
      />

      <View className="flex-row border-t border-neutral-200 px-4 py-2 dark:border-neutral-700">
        <View className="flex-1 pr-1">
          <Button
            label="← Previous"
            variant="outline"
            size="sm"
            disabled={!data.prev}
            onPress={() => data.prev && goToChapter(data.prev.slug)}
          />
        </View>
        <View className="flex-1 pl-1">
          <Button
            label="Next →"
            variant="outline"
            size="sm"
            disabled={!data.next}
            onPress={() => data.next && goToChapter(data.next.slug)}
          />
        </View>
      </View>
    </View>
  );
}
