import React from 'react';
import {
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { layout, typography } from '../theme';
import { useTheme } from '../context/ThemeContext';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: any;
}

export default function Button({
  title,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  style,
}: ButtonProps) {
  const { colors } = useTheme();

  const getContainerStyle = () => {
    const base = { backgroundColor: 'transparent', borderWidth: 1 };
    switch (variant) {
      case 'primary':
        return [{ ...base, backgroundColor: colors.accentTeal, borderColor: colors.accentTeal }];
      case 'secondary':
        return [{ ...base, borderColor: colors.border }];
      case 'ghost':
        return [{ ...base, borderColor: 'transparent' }];
    }
  };

  const getTextStyle = () => {
    switch (variant) {
      case 'primary': return { color: colors.background };
      case 'secondary': return { color: colors.textPrimary };
      case 'ghost': return { color: colors.accentTeal };
    }
  };

  return (
    <Pressable
      style={({ pressed }) => [
        styles.container,
        ...getContainerStyle(),
        pressed && variant === 'primary' && { opacity: 0.85 },
        pressed && variant === 'secondary' && { backgroundColor: colors.surfaceElevated },
        pressed && variant === 'ghost' && { backgroundColor: colors.surfaceElevated },
        (disabled || loading) && { opacity: 0.35 },
        style,
      ]}
      onPress={onPress}
      disabled={disabled || loading}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? colors.background : colors.accentTeal}
        />
      ) : (
        <Text style={[styles.text, getTextStyle()]}>{title}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 52,
    borderRadius: layout.cardRadius,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: layout.spacing.lg,
    width: '100%',
  },
  text: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.sm,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
});