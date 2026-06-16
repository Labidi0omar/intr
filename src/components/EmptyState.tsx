import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { layout, typography } from '../theme';

interface EmptyStateProps {
  title: string;
  body?: string;
  ctaLabel?: string;
  onCtaPress?: () => void;
}

export default function EmptyState({ title, body, ctaLabel, onCtaPress }: EmptyStateProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <View style={styles.wrap}>
      <View style={styles.glyph} />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {ctaLabel && onCtaPress ? (
        <TouchableOpacity style={styles.cta} onPress={onCtaPress} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{ctaLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: any) =>
  StyleSheet.create({
    wrap: {
      alignItems: 'center',
      paddingVertical: 56,
      paddingHorizontal: layout.spacing.lg,
    },
    glyph: {
      width: 64,
      height: 64,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      borderRadius: layout.smRadius,
      marginBottom: layout.spacing.lg,
    },
    title: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.lg,
      color: colors.textPrimary,
      letterSpacing: -0.4,
      marginBottom: layout.spacing.xs,
      textAlign: 'center',
    },
    body: {
      fontFamily: typography.family.body,
      fontSize: typography.size.sm,
      color: colors.textSecondary,
      lineHeight: 22,
      textAlign: 'center',
      maxWidth: 280,
    },
    cta: {
      marginTop: layout.spacing.xl,
      backgroundColor: colors.accentTeal,
      borderRadius: layout.cardRadius,
      paddingVertical: 14,
      paddingHorizontal: layout.spacing.xl,
    },
    ctaText: {
      fontFamily: typography.family.heading,
      fontSize: typography.size.sm,
      color: colors.background,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
  });
