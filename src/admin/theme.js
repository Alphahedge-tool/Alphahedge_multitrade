import { createTheme } from '@mui/material/styles'

const lightTokens = {
  blue: '#3F5BD9',
  blueHover: '#354CB5',
  blueSurface: '#E8ECFC',
  blueBg: '#F1F4FD',
  green: '#008F75',
  red: '#D64D4D',
  bold: '#253040',
  base: '#425061',
  caption: '#717A89',
  placeholder: '#959FB0',
  bg: '#F5F7FA',
  surface: '#FFFFFF',
  surface2: '#F1F4FD',
  hover: '#F5F7FA',
  border: '#DDDFE4',
  borderSoft: '#EAEBF1',
  shadowCard: '0 1px 2px rgba(43, 47, 63, .06), 0 4px 16px rgba(43, 47, 63, .06)',
  shadowPop: '0 4px 24px rgba(0, 0, 0, .12)',
}

const darkTokens = {
  blue: '#8EA2FF',
  blueHover: '#AFC0FF',
  blueSurface: '#242B3A',
  blueBg: '#171B24',
  green: '#24C6A4',
  red: '#FF6B6B',
  bold: '#F3F4F6',
  base: '#D1D5DB',
  caption: '#9CA3AF',
  placeholder: '#6B7280',
  bg: '#212124',
  surface: '#2A2A2E',
  surface2: '#333338',
  hover: '#3B3B41',
  border: '#45454D',
  borderSoft: '#38383F',
  shadowCard: '0 1px 2px rgba(0, 0, 0, .28), 0 12px 32px rgba(0, 0, 0, .28)',
  shadowPop: '0 18px 48px rgba(0, 0, 0, .42)',
}

// AlphaHedge theme — the blue-charcoal "Dhan / Angel-One" dark palette ported
// verbatim from the Alphahedgetool project (its default theme's design tokens).
// Warmer and more blue-tinted than the near-black `darkTokens`.
const alphahedgeTokens = {
  blue: '#5872E6',
  blueHover: '#3F5BD9',
  blueSurface: 'rgba(63,91,217,0.18)', // --blue-dim
  blueBg: '#252F3D',
  green: '#18A98D',                    // --bull
  red: '#E06363',                      // --bear
  bold: '#D7DEE8',                     // --tx-1
  base: '#D7DEE8',                     // --tx-2
  caption: '#9CA8B8',                  // --tx-3
  placeholder: '#9CA8B8',              // --tx-4
  bg: '#202A38',                       // --bg-0
  surface: '#252F3D',                  // --bg-1 / --bg-3
  surface2: '#2B3645',                 // --bg-4
  hover: 'rgba(63,91,217,0.10)',
  border: '#44505E',                   // --bd-4
  borderSoft: 'rgba(68,80,94,0.64)',   // --bd-2
  shadowCard: '0 1px 3px rgba(0,0,0,.5), 0 8px 32px -4px rgba(0,0,0,.45)',
  shadowPop: '0 18px 48px rgba(0,0,0,.5)',
}

// Terminal theme — the cool graphite "terminal-pro" palette ported verbatim
// from Alphahedgetool: near-black steel backgrounds, muted steel-blue accent,
// warm tan highlights, bright teal / salmon market colors.
const terminalTokens = {
  blue: '#8EA4C2',
  blueHover: '#A3B5CC',
  blueSurface: 'rgba(142,164,194,0.13)', // --blue-dim
  blueBg: '#14181D',
  green: '#12D6A0',                       // --bull
  red: '#FF5B67',                         // --bear
  bold: '#EEF1F5',                        // --tx-1
  base: '#DDE5ED',                        // --tx-2
  caption: '#9AA3AF',                     // --tx-3
  placeholder: '#7F8A98',                 // --tx-4
  bg: '#101113',                          // --bg-0
  surface: '#171D23',                     // --bg-2
  surface2: '#202832',                    // --bg-4
  hover: 'rgba(142,164,194,0.10)',
  border: '#394450',                      // --bd-3
  borderSoft: 'rgba(42,48,56,0.86)',      // --bd-2
  shadowCard: '0 1px 3px rgba(0,0,0,.6), 0 8px 32px -4px rgba(0,0,0,.5)',
  shadowPop: '0 18px 48px rgba(0,0,0,.6)',
}

const TOKENS_BY_MODE = { light: lightTokens, dark: darkTokens, alphahedge: alphahedgeTokens, terminal: terminalTokens }

export const getAdminTheme = (mode = 'light') => {
  const isDark = mode === 'dark' || mode === 'alphahedge' || mode === 'terminal'
  const tokens = TOKENS_BY_MODE[mode] || lightTokens

  return createTheme({
  palette: {
    mode: isDark ? 'dark' : 'light',
    primary: { main: tokens.blue, dark: tokens.blueHover, light: tokens.blueSurface },
    success: { main: tokens.green },
    error: { main: tokens.red },
    background: { default: tokens.bg, paper: tokens.surface },
    text: { primary: tokens.bold, secondary: tokens.caption },
    divider: tokens.borderSoft,
  },
  typography: {
    fontFamily: 'Roboto, ui-sans-serif, system-ui, "Segoe UI", Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: 0 },
    h5: { fontWeight: 700, letterSpacing: 0 },
    h6: { fontWeight: 700, letterSpacing: 0 },
    button: { fontWeight: 700, letterSpacing: 0, textTransform: 'none' },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: tokens.bg,
          color: tokens.base,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          background: tokens.surface,
          color: tokens.bold,
          borderBottom: `1px solid ${tokens.borderSoft}`,
          boxShadow: '0 1px 3px rgba(43, 47, 63, .04)',
        },
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          minHeight: '52px !important',
          paddingLeft: '16px !important',
          paddingRight: '16px !important',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          borderRadius: 8,
          boxShadow: tokens.shadowCard,
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: {
          minHeight: 34,
          borderRadius: 7,
          padding: '0 14px',
        },
        containedPrimary: {
          backgroundColor: tokens.blue,
          // Near-black dark uses a bright accent → dark text; alphahedge's blue
          // and light both read best with white text on the button.
          color: mode === 'dark' ? '#0E0F12' : '#fff',
          boxShadow: isDark ? '0 1px 2px rgba(124, 149, 255, .28)' : '0 1px 2px rgba(63, 91, 217, .35)',
          '&:hover': { backgroundColor: tokens.blueHover },
        },
        outlined: {
          borderColor: tokens.border,
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          width: 30,
          height: 30,
          borderRadius: 7,
          color: tokens.caption,
          '&:hover': {
            backgroundColor: tokens.surface2,
            color: tokens.base,
          },
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiFormControl: {
      defaultProps: {
        size: 'small',
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          minHeight: 38,
          borderRadius: 8,
          backgroundColor: tokens.surface,
          color: tokens.base,
          '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: isDark ? '#475569' : '#cfd3da' },
          '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
            borderColor: tokens.blue,
            boxShadow: `0 0 0 3px ${tokens.blueSurface}`,
          },
        },
        notchedOutline: {
          borderColor: tokens.border,
        },
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          color: tokens.caption,
          fontWeight: 600,
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: `1px solid ${tokens.borderSoft}`,
          color: tokens.base,
          fontSize: '0.8125rem',
        },
        head: {
          backgroundColor: tokens.surface2,
          color: tokens.caption,
          fontSize: '0.75rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.02em',
        },
      },
    },
    MuiTableRow: {
      styleOverrides: {
        root: {
          '&:hover td': { backgroundColor: tokens.hover },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: 8,
          border: `1px solid ${tokens.borderSoft}`,
        },
      },
    },
    MuiDialogTitle: {
      styleOverrides: {
        root: {
          color: tokens.bold,
          fontWeight: 700,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${tokens.borderSoft}`,
          boxShadow: tokens.shadowPop,
        },
      },
    },
  },
})
}

export const adminTheme = getAdminTheme('light')
