import { Tabs, useRouter } from 'expo-router';
import * as React from 'react';
import { Pressable } from 'react-native';

import {
  Feed as FeedIcon,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Style as StyleIcon,
} from '@/components/ui/icons';

function SearchButton() {
  const router = useRouter();
  return (
    <Pressable onPress={() => router.push('/search')} className="mr-3">
      <SearchIcon color="#666" />
    </Pressable>
  );
}

export default function TabLayout() {
  return (
    <Tabs>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Books',
          tabBarIcon: ({ color }) => <FeedIcon color={color} />,
          tabBarButtonTestID: 'feed-tab',
          headerRight: () => <SearchButton />,
        }}
      />

      <Tabs.Screen
        name="style"
        options={{
          title: 'Library',
          headerShown: false,
          tabBarIcon: ({ color }) => <StyleIcon color={color} />,
          tabBarButtonTestID: 'style-tab',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerShown: false,
          tabBarIcon: ({ color }) => <SettingsIcon color={color} />,
          tabBarButtonTestID: 'settings-tab',
        }}
      />
    </Tabs>
  );
}
