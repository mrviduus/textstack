import type { LibraryItem } from '@/lib/api/types';
import { FlashList } from '@shopify/flash-list';
import { Link, useRouter } from 'expo-router';
import * as React from 'react';

import {
  Button,
  EmptyList,
  FocusAwareStatusBar,
  Image,
  Pressable,
  Text,
  View,
} from '@/components/ui';
import { useAuthStore } from '@/features/auth/use-auth-store';
import { getStorageUrl } from '@/lib/api';
import { useLibrary } from './api';

function LibraryCard({ item }: { item: LibraryItem }) {
  const coverUri = getStorageUrl(item.coverPath);

  return (
    <Link href={`/feed/${item.slug}`} asChild>
      <Pressable>
        <View className="m-2 flex-row overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900">
          {coverUri ? (
            <Image
              className="h-32 w-24"
              contentFit="cover"
              source={{ uri: coverUri }}
            />
          ) : (
            <View className="h-32 w-24 items-center justify-center bg-neutral-100 dark:bg-neutral-800">
              <Text className="text-2xl">📖</Text>
            </View>
          )}
          <View className="flex-1 justify-center p-3">
            <Text className="text-base font-semibold" numberOfLines={2}>
              {item.title}
            </Text>
            <Text className="mt-1 text-xs text-gray-400">
              {item.language.toUpperCase()}
            </Text>
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

function SignInPrompt() {
  const router = useRouter();
  return (
    <View className="flex-1 items-center justify-center p-6">
      <Text className="mb-2 text-center text-lg font-semibold">
        My Library
      </Text>
      <Text className="mb-6 text-center text-gray-500">
        Sign in to save books and track your reading progress.
      </Text>
      <Button
        label="Sign In"
        onPress={() => router.push('/login')}
        size="sm"
      />
    </View>
  );
}

function EmptyLibrary() {
  const router = useRouter();
  return (
    <View className="flex-1 items-center justify-center p-6">
      <Text className="mb-2 text-center text-lg font-semibold">
        Your library is empty
      </Text>
      <Text className="mb-6 text-center text-gray-500">
        Browse books and add them to your library.
      </Text>
      <Button
        label="Browse Books"
        onPress={() => router.push('/')}
        size="sm"
      />
    </View>
  );
}

export function LibraryScreen() {
  const user = useAuthStore.use.user();

  if (!user) {
    return (
      <>
        <FocusAwareStatusBar />
        <SignInPrompt />
      </>
    );
  }

  return <AuthenticatedLibrary />;
}

function AuthenticatedLibrary() {
  const { data, isPending, isError, refetch } = useLibrary();

  const renderItem = React.useCallback(
    ({ item }: { item: LibraryItem }) => <LibraryCard item={item} />,
    [],
  );

  if (isError) {
    return (
      <View className="flex-1 items-center justify-center">
        <FocusAwareStatusBar />
        <Text className="text-center">Error loading library</Text>
        <Button label="Retry" onPress={() => refetch()} size="sm" variant="outline" className="mt-4" />
      </View>
    );
  }

  const items = data?.items ?? [];

  return (
    <View className="flex-1">
      <FocusAwareStatusBar />
      {!isPending && items.length === 0 ? (
        <EmptyLibrary />
      ) : (
        <FlashList
          data={items}
          renderItem={renderItem}
          keyExtractor={(item) => item.editionId}
          ListEmptyComponent={<EmptyList isLoading={isPending} />}
        />
      )}
    </View>
  );
}
