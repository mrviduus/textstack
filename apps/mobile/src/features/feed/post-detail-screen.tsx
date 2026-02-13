import { Link, Stack, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { ScrollView } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import {
  ActivityIndicator,
  Button,
  FocusAwareStatusBar,
  Image,
  Text,
  View,
} from '@/components/ui';
import { useAuthStore } from '@/features/auth/use-auth-store';
import {
  useAddToLibrary,
  useLibrary,
  useRemoveFromLibrary,
} from '@/features/library/api';
import { useReadingProgress } from '@/features/reader/api';
import { getStorageUrl } from '@/lib/api';
import { useBook } from './api';

function LibraryButton({ editionId }: { editionId: string }) {
  const user = useAuthStore.use.user();
  const { data: library } = useLibrary({ enabled: !!user });
  const queryClient = useQueryClient();

  const isInLibrary = library?.items.some((i) => i.editionId === editionId) ?? false;

  const addMutation = useAddToLibrary({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['library'] }),
  });
  const removeMutation = useRemoveFromLibrary({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['library'] }),
  });

  const loading = addMutation.isPending || removeMutation.isPending;

  if (!user) return null;

  const handlePress = () => {
    if (isInLibrary) {
      removeMutation.mutate({ editionId });
    } else {
      addMutation.mutate({ editionId });
    }
  };

  return (
    <Button
      label={isInLibrary ? 'In Library' : 'Add to Library'}
      variant={isInLibrary ? 'outline' : 'secondary'}
      size="sm"
      className="mt-2"
      loading={loading}
      onPress={handlePress}
    />
  );
}

export function PostDetailScreen() {
  const local = useLocalSearchParams<{ id: string }>();

  const { data, isPending, isError } = useBook({
    variables: { slug: local.id },
  });

  if (isPending) {
    return (
      <View className="flex-1 justify-center p-3">
        <Stack.Screen options={{ title: 'Book', headerBackTitle: 'Books' }} />
        <FocusAwareStatusBar />
        <ActivityIndicator />
      </View>
    );
  }
  if (isError) {
    return (
      <View className="flex-1 justify-center p-3">
        <Stack.Screen options={{ title: 'Book', headerBackTitle: 'Books' }} />
        <FocusAwareStatusBar />
        <Text className="text-center">Error loading book</Text>
      </View>
    );
  }

  const user = useAuthStore.use.user();
  const { data: progress } = useReadingProgress({
    variables: { editionId: data.id },
    enabled: !!user,
  });

  const coverUri = getStorageUrl(data.coverPath);
  const authorNames = data.authors?.map((a) => a.name).join(', ') || '';
  const firstChapter = data.chapters[0];
  const resumeChapter = progress?.chapterSlug ?? firstChapter?.slug;

  return (
    <ScrollView className="flex-1">
      <Stack.Screen options={{ title: data.title, headerBackTitle: 'Books' }} />
      <FocusAwareStatusBar />

      {coverUri ? (
        <Image
          className="h-64 w-full"
          contentFit="cover"
          source={{ uri: coverUri }}
        />
      ) : null}

      <View className="p-4">
        <Text className="text-2xl font-bold">{data.title}</Text>
        {authorNames ? (
          <Text className="mt-1 text-base text-gray-500">{authorNames}</Text>
        ) : null}
        {data.description ? (
          <Text className="mt-3 leading-relaxed text-gray-700 dark:text-gray-300">
            {data.description}
          </Text>
        ) : null}

        <View className="mt-4 flex-row gap-2">
          {resumeChapter ? (
            <Link href={`/feed/${data.slug}/${resumeChapter}`} asChild>
              <Button
                label={progress ? 'Continue Reading' : 'Read'}
                className="flex-1"
              />
            </Link>
          ) : null}
        </View>

        {progress?.percent != null ? (
          <View className="mt-2">
            <View className="h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
              <View
                className="h-full rounded-full bg-blue-500"
                style={{ width: `${Math.round(progress.percent)}%` }}
              />
            </View>
            <Text className="mt-1 text-xs text-gray-400">
              {Math.round(progress.percent)}% complete
            </Text>
          </View>
        ) : null}

        <LibraryButton editionId={data.id} />

        <Text className="mt-6 text-lg font-semibold">
          Chapters ({data.chapters.length})
        </Text>
        {data.chapters.map((ch) => (
          <Link
            key={ch.id}
            href={`/feed/${data.slug}/${ch.slug}`}
            className="border-b border-neutral-200 py-3 dark:border-neutral-700"
          >
            <Text className="text-base">{ch.title}</Text>
          </Link>
        ))}
      </View>
    </ScrollView>
  );
}
