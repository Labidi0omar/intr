import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { layout, typography } from '../theme';

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
}

export default function Input({
  label,
  error,
  onFocus,
  onBlur,
  ...props
}: InputProps) {
  const { colors } = useTheme();
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={styles.container}>
      {label && <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text>}
      <TextInput
        style={[
          styles.input,
          { color: colors.textPrimary, backgroundColor: colors.surface, borderColor: colors.border },
          isFocused && { borderColor: colors.accentTeal, backgroundColor: colors.surfaceElevated },
          error && { borderColor: colors.accentRed, backgroundColor: colors.surface },
        ]}
        placeholderTextColor={colors.textMuted}
        onFocus={(e) => {
          setIsFocused(true);
          onFocus && onFocus(e);
        }}
        onBlur={(e) => {
          setIsFocused(false);
          onBlur && onBlur(e);
        }}
        {...props}
      />
      {error ? <Text style={[styles.errorText, { color: colors.accentRed }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: layout.spacing.lg,
    width: '100%',
  },
  label: {
    fontFamily: typography.family.heading,
    fontSize: typography.size.xxs,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: layout.spacing.xs,
  },
  input: {
    height: 52,
    borderRadius: layout.cardRadius,
    paddingHorizontal: layout.spacing.md,
    fontFamily: typography.family.body,
    fontSize: typography.size.md,
    borderWidth: 1,
  },
  errorText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.xs,
    marginTop: layout.spacing.xs,
  },
});