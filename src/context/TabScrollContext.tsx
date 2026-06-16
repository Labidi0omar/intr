import { createContext, useContext } from 'react';

export const TabScrollContext = createContext({
  disableScroll: () => {},
  enableScroll: () => {},
  goToSubTab: (_index: number) => {},
});

export const useTabScroll = () => useContext(TabScrollContext);
