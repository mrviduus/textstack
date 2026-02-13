import type { Edition } from '@/lib/api/types';

import { Link } from 'expo-router';
import * as React from 'react';

import { Image, Pressable, Text, View } from '@/components/ui';
import { getStorageUrl } from '@/lib/api';

type Props = {
  book: Edition;
};

export function BookCard({ book }: Props) {
  const coverUri = getStorageUrl(book.coverPath);
  const authorNames = book.authors?.map(a => a.name).join(', ') || '';

  return (
    <Link href={`/feed/${book.slug}`} asChild>
      <Pressable>
        <View className="m-2 flex-row overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
          {coverUri
            ? (
                <Image
                  className="h-40 w-28"
                  contentFit="cover"
                  source={{ uri: coverUri }}
                />
              )
            : (
                <View className="h-40 w-28 items-center justify-center bg-neutral-100 dark:bg-neutral-800">
                  <Text className="text-3xl">📖</Text>
                </View>
              )}

          <View className="flex-1 p-3">
            <Text className="text-lg font-semibold" numberOfLines={2}>
              {book.title}
            </Text>
            {authorNames
              ? (
                  <Text className="mt-1 text-sm text-gray-500" numberOfLines={1}>
                    {authorNames}
                  </Text>
                )
              : null}
            {book.description
              ? (
                  <Text className="mt-2 text-sm leading-snug text-gray-600 dark:text-gray-400" numberOfLines={3}>
                    {book.description}
                  </Text>
                )
              : null}
            <Text className="mt-auto pt-2 text-xs text-gray-400">
              {book.chapterCount}
              {' '}
              chapters
            </Text>
          </View>
        </View>
      </Pressable>
    </Link>
  );
}
