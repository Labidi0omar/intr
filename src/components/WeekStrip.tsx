import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { layout, typography } from '../theme';

export type WeekDayState = 'completed' | 'missed' | 'planned' | 'rest';

export interface WeekStripDay {
  date: string;
  dayName: string;
  isToday: boolean;
  state: WeekDayState;
}

interface WeekStripProps {
  days: WeekStripDay[];
  showCard?: boolean;
}

export default function WeekStrip({ days, showCard = true }: WeekStripProps) {
  const { colors } = useTheme();
  const styles = makeStyles(colors);

  return (
    <View style={showCard ? styles.card : styles.bare}>
      {days.map((day, idx) => {
        const initial = day.dayName ? day.dayName.charAt(0) : '';

        let dot: React.ReactNode;
        if (day.state === 'completed') {
          dot = <View style={[styles.dot, styles.dotCompleted]} />;
        } else if (day.state === 'rest') {
          dot = <View style={[styles.dot, styles.dotRest]} />;
        } else {
          // planned (future) and missed (past) both render as a neutral ring;
          // the date axis disambiguates them. missed gets a small "·" inside.
          dot = (
            <View style={[styles.dot, styles.dotRing]}>
              {day.state === 'missed' ? <Text style={styles.dotMissedGlyph}>·</Text> : null}
            </View>
          );
        }

        return (
          <View key={idx} style={styles.col}>
            {dot}
            <Text
              style={[
                styles.label,
                day.isToday && { color: colors.accentTeal, fontFamily: typography.family.bodyMedium },
              ]}
            >
              {initial}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const DOT_SIZE = 18;

const makeStyles = (colors: any) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: layout.cardRadius,
      borderWidth: 1,
      borderColor: colors.cardBorder,
      paddingVertical: layout.spacing.md,
      paddingHorizontal: layout.spacing.md,
    },
    bare: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: layout.spacing.sm,
    },
    col: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      flex: 1,
    },
    dot: {
      width: DOT_SIZE,
      height: DOT_SIZE,
      borderRadius: DOT_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dotCompleted: {
      backgroundColor: colors.accentTeal,
    },
    dotRing: {
      borderWidth: 1,
      borderColor: colors.line ?? colors.border,
      backgroundColor: 'transparent',
    },
    dotRest: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.textMuted,
      margin: 6,
    },
    dotMissedGlyph: {
      fontSize: 14,
      lineHeight: 14,
      color: colors.textMuted,
      marginTop: -3,
    },
    label: {
      fontFamily: typography.family.body,
      fontSize: 10,
      letterSpacing: 0.6,
      color: colors.textMuted,
    },
  });
