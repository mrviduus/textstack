import type { Edition } from '@/lib/api/types';
import { FlashList } from '@shopify/flash-list';

import * as React from 'react';
import { EmptyList, FocusAwareStatusBar, Text, View } from '@/components/ui';
import { useBooks } from './api';
import { BookCard } from './components/book-card';

export function FeedScreen() {
  const { data, isPending, isError } = useBooks();
  const renderItem = React.useCallback(
    ({ item }: { item: Edition }) => <BookCard book={item} />,
    [],
  );

  if (isError) {
    return (
      <View>
        <Text>Error loading books</Text>
      </View>
    );
  }
  return (
    <View className="flex-1">
      <FocusAwareStatusBar />
      <FlashList
        data={data?.items}
        renderItem={renderItem}
        keyExtractor={item => item.id}
        ListEmptyComponent={<EmptyList isLoading={isPending} />}
      />
    </View>
  );
}
