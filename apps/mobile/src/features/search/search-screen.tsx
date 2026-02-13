import type { SearchResult, Suggestion } from '@/lib/api/types';
import { FlashList } from '@shopify/flash-list';
import { Link } from 'expo-router';
import * as React from 'react';
import { TextInput, useColorScheme } from 'react-native';

import {
  ActivityIndicator,
  FocusAwareStatusBar,
  Image,
  Pressable,
  Text,
  View,
} from '@/components/ui';
import { getStorageUrl } from '@/lib/api';
import { useSearch, useSuggestions } from '@/features/feed/api';

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function SuggestionItem({ item }: { item: Suggestion }) {
  const coverUri = getStorageUrl(item.coverPath);

  return (
    <Link href={`/feed/${item.slug}`} asChild>
      <Pressable>
        <View className="flex-row items-center border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          {coverUri ? (
            <Image
              className="mr-3 h-12 w-8 rounded"
              contentFit="cover"
              source={{ uri: coverUri }}
            />
          ) : (
            <View className="mr-3 h-12 w-8 items-center justify-center rounded bg-neutral-100 dark:bg-neutral-800">
              <Text className="text-xs">📖</Text>
            </View>
          )}
          <View className="flex-1">
            <Text className="text-base font-medium" numberOfLines={1}>
              {item.text}
            </Text>
            {item.authors ? (
              <Text className="text-sm text-gray-500" numberOfLines={1}>
                {item.authors}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

function SearchResultItem({ item }: { item: SearchResult }) {
  const coverUri = getStorageUrl(item.edition.coverPath);
  const highlight =
    item.highlights?.[0]?.replace(/<\/?b>/g, '') ?? item.chapterTitle ?? '';

  return (
    <Link
      href={`/feed/${item.edition.slug}/${item.chapterSlug ?? ''}`}
      asChild
    >
      <Pressable>
        <View className="flex-row border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          {coverUri ? (
            <Image
              className="mr-3 h-16 w-11 rounded"
              contentFit="cover"
              source={{ uri: coverUri }}
            />
          ) : null}
          <View className="flex-1">
            <Text className="text-base font-medium" numberOfLines={1}>
              {item.edition.title}
            </Text>
            {item.chapterTitle ? (
              <Text className="text-sm text-gray-500" numberOfLines={1}>
                Ch. {item.chapterNumber}: {item.chapterTitle}
              </Text>
            ) : null}
            {highlight ? (
              <Text
                className="mt-1 text-sm text-gray-400"
                numberOfLines={2}
              >
                {highlight}
              </Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

export function SearchScreen() {
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebounce(query, 300);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const showSuggestions = debouncedQuery.length > 0 && debouncedQuery.length < 3;
  const showResults = debouncedQuery.length >= 3;

  const { data: suggestions, isPending: suggestionsLoading } = useSuggestions({
    variables: { q: debouncedQuery, limit: 8 },
    enabled: showSuggestions || showResults,
  });

  const { data: results, isPending: resultsLoading } = useSearch({
    variables: { q: debouncedQuery, limit: 20 },
    enabled: showResults,
  });

  const renderSuggestion = React.useCallback(
    ({ item }: { item: Suggestion }) => <SuggestionItem item={item} />,
    [],
  );

  const renderResult = React.useCallback(
    ({ item }: { item: SearchResult }) => <SearchResultItem item={item} />,
    [],
  );

  return (
    <View className="flex-1">
      <FocusAwareStatusBar />

      <View className="border-b border-neutral-200 px-4 py-2 dark:border-neutral-700">
        <TextInput
          className="h-10 rounded-lg bg-neutral-100 px-4 text-base dark:bg-neutral-800 dark:text-white"
          placeholder="Search books..."
          placeholderTextColor={isDark ? '#999' : '#666'}
          value={query}
          onChangeText={setQuery}
          autoFocus
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>

      {!debouncedQuery ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-gray-400">
            Search for books by title, author, or content
          </Text>
        </View>
      ) : showResults ? (
        resultsLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator />
          </View>
        ) : results && results.items.length > 0 ? (
          <FlashList
            data={results.items}
            renderItem={renderResult}
            keyExtractor={(item) => `${item.edition.id}-${item.chapterId}`}
            />
        ) : (
          <View className="flex-1 items-center justify-center p-6">
            <Text className="text-gray-400">No results found</Text>
          </View>
        )
      ) : suggestionsLoading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      ) : suggestions && suggestions.length > 0 ? (
        <FlashList
          data={suggestions}
          renderItem={renderSuggestion}
          keyExtractor={(item) => item.slug}
        />
      ) : null}
    </View>
  );
}
