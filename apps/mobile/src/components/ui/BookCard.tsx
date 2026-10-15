import { useEffect, useRef } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Animated } from 'react-native'
import { Image } from 'expo-image'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'

interface BookCardProps {
  title: string
  author?: string
  coverUrl?: string | null
  onPress: () => void
  animationDelay?: number
  badge?: number
}

export function BookCard({ title, author, coverUrl, onPress, animationDelay = 0, badge }: BookCardProps) {
  const { colors } = useTheme()
  const fadeAnim = useRef(new Animated.Value(animationDelay > 0 ? 0 : 1)).current
  const slideAnim = useRef(new Animated.Value(animationDelay > 0 ? 20 : 0)).current

  useEffect(() => {
    if (animationDelay > 0) {
      const timer = setTimeout(() => {
        Animated.parallel([
          Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(slideAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
        ]).start()
      }, animationDelay)
      return () => clearTimeout(timer)
    }
  }, [])

  return (
    <Animated.View style={{ width: '48%', marginBottom: 20, opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}>
      <TouchableOpacity onPress={onPress} activeOpacity={0.85} testID="book-card">
        <View style={[styles.coverWrapper, { backgroundColor: colors.surface }]}>
          {coverUrl ? (
            <Image source={{ uri: coverUrl }} style={styles.cover} contentFit="cover" />
          ) : (
            <View style={[styles.cover, styles.placeholder, { backgroundColor: colors.primaryLight }]}>
              <Text style={[styles.placeholderText, { color: colors.primary }]}>
                {title.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          {badge != null && badge > 0 && (
            <View style={[styles.badge, { backgroundColor: colors.primaryLight }]}>
              <Text style={[styles.badgeText, { color: colors.primary }]}>{badge}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {title}
        </Text>
        {author && (
          <Text style={[styles.author, { color: colors.textSecondary }]} numberOfLines={1}>
            {author}
          </Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  coverWrapper: {
    aspectRatio: 2 / 3,
    borderRadius: 6,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    fontFamily: fonts.serif,
    fontSize: 48,
  },
  title: {
    fontFamily: fonts.sansMedium,
    fontSize: 14,
    lineHeight: 18,
    marginTop: 8,
  },
  author: {
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  badge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 8,
    minWidth: 20,
    alignItems: 'center',
  },
  badgeText: {
    fontFamily: fonts.sansMedium,
    fontSize: 10,
  },
})
