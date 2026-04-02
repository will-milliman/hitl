/**
 * Catppuccin Mocha theme for styled-components.
 * https://github.com/catppuccin/catppuccin
 */
export const theme = {
  colors: {
    // Base colors
    base: '#1e1e2e',
    mantle: '#181825',
    crust: '#11111b',

    // Surface colors
    surface0: '#313244',
    surface1: '#45475a',
    surface2: '#585b70',

    // Overlay colors
    overlay0: '#6c7086',
    overlay1: '#7f849c',
    overlay2: '#9399b2',

    // Text colors
    text: '#cdd6f4',
    subtext0: '#a6adc8',
    subtext1: '#bac2de',

    // Accent colors
    rosewater: '#f5e0dc',
    flamingo: '#f2cdcd',
    pink: '#f5c2e7',
    mauve: '#cba6f7',
    red: '#f38ba8',
    maroon: '#eba0ac',
    peach: '#fab387',
    yellow: '#f9e2af',
    green: '#a6e3a1',
    teal: '#94e2d5',
    sky: '#89dceb',
    sapphire: '#74c7ec',
    blue: '#89b4fa',
    lavender: '#b4befe',
  },

  fonts: {
    mono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
    sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },

  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
  },

  radii: {
    sm: '4px',
    md: '8px',
    lg: '12px',
  },
} as const;

export type Theme = typeof theme;
