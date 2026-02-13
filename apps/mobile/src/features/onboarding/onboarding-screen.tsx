import { useRouter } from 'expo-router';
import * as React from 'react';

import {
  Button,
  FocusAwareStatusBar,
  SafeAreaView,
  Text,
  View,
} from '@/components/ui';
import { useIsFirstTime } from '@/lib/hooks';
import { Cover } from './components/cover';

export function OnboardingScreen() {
  const [_, setIsFirstTime] = useIsFirstTime();
  const router = useRouter();
  return (
    <View className="flex h-full items-center justify-center">
      <FocusAwareStatusBar />
      <View className="w-full flex-1">
        <Cover />
      </View>
      <View className="justify-end">
        <Text className="my-3 text-center text-5xl font-bold">
          TextStack
        </Text>
        <Text className="mb-2 text-center text-lg text-gray-600">
          A calm place to read books
        </Text>

        <Text className="my-1 pt-6 text-left text-lg">
          Free classic literature
        </Text>
        <Text className="my-1 text-left text-lg">
          Kindle-like reading experience
        </Text>
        <Text className="my-1 text-left text-lg">
          Save progress across devices
        </Text>
        <Text className="my-1 text-left text-lg">
          Offline reading support
        </Text>
      </View>
      <SafeAreaView className="mt-6">
        <Button
          label="Get Started"
          onPress={() => {
            setIsFirstTime(false);
            router.replace('/login');
          }}
        />
      </SafeAreaView>
    </View>
  );
}
