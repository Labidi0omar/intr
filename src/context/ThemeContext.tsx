import React, { createContext, useContext } from 'react';
import { theme, IntrTheme } from '../theme';

type ThemeContextType = {
  theme: IntrTheme;
  colors: IntrTheme['colors'];
};

const ThemeContext = createContext<ThemeContextType>({
  theme,
  colors: theme.colors,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <ThemeContext.Provider value={{ theme, colors: theme.colors }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}