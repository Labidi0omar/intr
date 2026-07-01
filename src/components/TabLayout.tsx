import React, { useRef, useCallback, useState } from 'react';
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { TabScrollContext } from '../context/TabScrollContext';
import { typography, layout, elevation } from '../theme';

import HomeScreen from '../../app/(tabs)/home';
import ProgressScreen from '../../app/(tabs)/progress';
import HistoryScreen from '../../app/(tabs)/history';
import CoachScreen from '../../app/(tabs)/coach';
import JournalScreen from '../../app/(tabs)/journal';
import ProfileScreen from '../../app/(tabs)/profile';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const TOP_TABS = ['Workout', 'Journal', 'Profile'] as const;
export const WORKOUT_SUB_TABS = ['Dashboard', 'Progress', 'History', 'Coach'] as const;

export default function TabLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [activeTopTab, setActiveTopTab] = useState(0);
  const [activeSubTab, setActiveSubTab] = useState(0);
  // Track which sub-tabs have been visited so we only mount a screen when
  // it's first scrolled to. This prevents all 4 sub-screens from firing
  // their network loads on initial app open. Once visited, a tab stays
  // mounted so the pager scroll position is preserved.
  const [mountedSubTabs, setMountedSubTabs] = useState<Set<number>>(new Set([0]));

  const scrollViewRef = useRef<ScrollView>(null);

  const disableScroll = useCallback(() => {
    scrollViewRef.current?.setNativeProps({ scrollEnabled: false });
  }, []);

  const enableScroll = useCallback(() => {
    scrollViewRef.current?.setNativeProps({ scrollEnabled: true });
  }, []);

  const handleTopTabPress = (index: number) => {
    setActiveTopTab(index);
  };

  const handleSubTabPress = useCallback((index: number) => {
    if (index < 0 || index >= WORKOUT_SUB_TABS.length) return;
    setActiveSubTab(index);
    setMountedSubTabs(prev => prev.has(index) ? prev : new Set(prev).add(index));
    scrollViewRef.current?.scrollTo({
      x: index * SCREEN_WIDTH,
      animated: true,
    });
  }, []);

  // Exposed via TabScrollContext so screens inside the pager (e.g. the
  // dashboard coach card) can jump to a sibling sub-tab.
  const goToSubTab = handleSubTabPress;

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offsetX = event.nativeEvent.contentOffset.x;
    const index = Math.round(offsetX / SCREEN_WIDTH);
    if (index >= 0 && index < WORKOUT_SUB_TABS.length && index !== activeSubTab) {
      setActiveSubTab(index);
      setMountedSubTabs(prev => prev.has(index) ? prev : new Set(prev).add(index));
    }
  };

  const renderWorkoutContent = () => (
    <ScrollView
      ref={scrollViewRef}
      horizontal
      pagingEnabled
      showsHorizontalScrollIndicator={false}
      scrollEventThrottle={16}
      onScroll={handleScroll}
      style={styles.subScrollView}
      contentContainerStyle={{ width: SCREEN_WIDTH * WORKOUT_SUB_TABS.length }}
    >
      <View key="home" style={{ width: SCREEN_WIDTH }}>
        {mountedSubTabs.has(0) ? <HomeScreen /> : null}
      </View>
      <View key="progress" style={{ width: SCREEN_WIDTH }}>
        {mountedSubTabs.has(1) ? <ProgressScreen /> : null}
      </View>
      <View key="history" style={{ width: SCREEN_WIDTH }}>
        {mountedSubTabs.has(2) ? <HistoryScreen /> : null}
      </View>
      <View key="coach" style={{ width: SCREEN_WIDTH }}>
        {mountedSubTabs.has(3) ? <CoachScreen /> : null}
      </View>
    </ScrollView>
  );

  const renderJournalContent = () => <JournalScreen />;
  const renderProfileContent = () => <ProfileScreen />;

  return (
    <TabScrollContext.Provider value={{ disableScroll, enableScroll, goToSubTab }}>
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>

        {/* Top tab bar */}
        <View style={[styles.topTabBar, { borderBottomColor: colors.border }]}>
          {TOP_TABS.map((label, index) => {
            const isActive = index === activeTopTab;
            return (
              <TouchableOpacity
                key={label}
                style={styles.topTabItem}
                onPress={() => handleTopTabPress(index)}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.topTabText,
                    { color: isActive ? colors.textPrimary : colors.textMuted },
                  ]}
                >
                  {label.toUpperCase()}
                </Text>
                {isActive && (
                  <View style={[styles.topTabUnderline, { backgroundColor: colors.accentTeal }]} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Content area */}
        <View style={styles.contentArea}>
          {activeTopTab === 0 && renderWorkoutContent()}
          {activeTopTab === 1 && renderJournalContent()}
          {activeTopTab === 2 && renderProfileContent()}
        </View>

        {/* Workout sub-tab bar (pill segmented control, anchored bottom) */}
        {activeTopTab === 0 && (
          <View style={[styles.pillBarWrap, { paddingBottom: Math.max(insets.bottom, 8) }]}>
            <View style={[styles.pillTrack, { backgroundColor: colors.surface }]}>
              {WORKOUT_SUB_TABS.map((label, index) => {
                const isActive = index === activeSubTab;
                return (
                  <TouchableOpacity
                    key={label}
                    style={[
                      styles.pillItem,
                      isActive && {
                        backgroundColor: colors.surfaceElevated,
                        shadowColor: colors.shadowColor,
                        ...elevation.subtle,
                      },
                    ]}
                    onPress={() => handleSubTabPress(index)}
                    activeOpacity={0.7}
                  >
                    <Text
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.85}
                      style={[
                        styles.pillText,
                        { color: isActive ? colors.accentTeal : colors.textMuted },
                      ]}
                    >
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}
      </View>
    </TabScrollContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topTabBar: {
    flexDirection: 'row',
    height: 44,
    alignItems: 'flex-end',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  topTabItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingBottom: 12,
  },
  topTabText: {
    fontFamily: 'Syne_700Bold',
    fontSize: typography.size.s12,
    letterSpacing: 1,
  },
  topTabUnderline: {
    position: 'absolute',
    bottom: 0,
    left: '25%',
    right: '25%',
    height: 2,
  },
  contentArea: {
    flex: 1,
  },
  pillBarWrap: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  pillTrack: {
    flexDirection: 'row',
    borderRadius: layout.radii.r16,
    padding: 6,
    gap: 4,
  },
  pillItem: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: layout.radii.r12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillText: {
    fontFamily: typography.family.bodyMedium,
    fontSize: typography.size.s12,
    letterSpacing: 0,
    // Keep every sub-tab label on a single line ("Dashboard" was wrapping to
    // "Dashboar\nd"); adjustsFontSizeToFit shrinks slightly only if needed.
    textAlign: 'center',
  },
  subScrollView: {
    flex: 1,
  },
});