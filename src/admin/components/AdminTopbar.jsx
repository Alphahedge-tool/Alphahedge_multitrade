import {
  AppBar,
  Box,
  Divider,
  IconButton,
  Menu,
  MenuItem,
  Toolbar,
  Typography,
} from '@mui/material'
import { LogOut, Moon, Palette, Settings, ShieldCheck, Sun, Terminal } from 'lucide-react'
import { useState } from 'react'

// Theme cycle metadata: icon + tooltip for each mode. Clicking advances to the
// "next" mode (Light -> Dark -> AlphaHedge -> Terminal -> Light).
const THEME_META = {
  light: { icon: Sun, next: 'Dark mode', accent: false },
  dark: { icon: Moon, next: 'AlphaHedge theme', accent: true },
  alphahedge: { icon: Palette, next: 'Terminal theme', accent: true },
  terminal: { icon: Terminal, next: 'Light mode', accent: true },
}

function AdminTopbar({ admin, onLogout, themeMode = 'light', onToggleTheme }) {
  const [anchorEl, setAnchorEl] = useState(null)

  const handleCloseMenu = () => setAnchorEl(null)
  const meta = THEME_META[themeMode] || THEME_META.light
  const ThemeIcon = meta.icon

  return (
    <>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ justifyContent: 'space-between' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box
              sx={{
                width: 28,
                height: 28,
                borderRadius: 1,
                display: 'grid',
                placeItems: 'center',
                color: 'primary.main',
                bgcolor: 'primary.light',
              }}
            >
              <ShieldCheck size={16} />
            </Box>
            <Typography sx={{ fontSize: '0.9375rem', fontWeight: 800, color: 'text.primary' }}>
              AlphaHedge Core
            </Typography>
            <Typography sx={{ fontSize: '0.8125rem', fontWeight: 700, color: 'text.secondary' }}>
              Admin
            </Typography>
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <IconButton
              size="small"
              title={`Switch to ${meta.next}`}
              aria-label={`Switch to ${meta.next}`}
              onClick={onToggleTheme}
              sx={{
                color: meta.accent ? 'primary.main' : 'text.secondary',
                bgcolor: meta.accent ? 'primary.light' : 'transparent',
              }}
            >
              <ThemeIcon size={17} />
            </IconButton>

            <IconButton
              size="small"
              title="Settings"
              onClick={(e) => setAnchorEl(e.currentTarget)}
            >
              <Settings size={17} />
            </IconButton>
          </Box>

          <Menu
            anchorEl={anchorEl}
            open={Boolean(anchorEl)}
            onClose={handleCloseMenu}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            <Box sx={{ px: 2, py: 1 }}>
              <Typography sx={{ fontSize: '0.75rem', color: 'primary.main', fontWeight: 700 }}>
                Last login
              </Typography>
              <Typography sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                {admin?.last_login ? new Date(admin.last_login).toLocaleString() : 'Not available'}
              </Typography>
            </Box>

            <Divider />

            <MenuItem onClick={onLogout}>
              <LogOut size={15} style={{ marginRight: 8 }} />
              Logout
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>
    </>
  )
}

export default AdminTopbar
