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
import { LogOut, Moon, Settings, ShieldCheck, Sun } from 'lucide-react'
import { useState } from 'react'

function AdminTopbar({ admin, onLogout, themeMode = 'light', onToggleTheme }) {
  const [anchorEl, setAnchorEl] = useState(null)

  const handleCloseMenu = () => setAnchorEl(null)
  const isDark = themeMode === 'dark'

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
              title={isDark ? 'Switch to normal mode' : 'Switch to dark mode'}
              aria-label={isDark ? 'Switch to normal mode' : 'Switch to dark mode'}
              onClick={onToggleTheme}
              sx={{
                color: isDark ? 'warning.main' : 'text.secondary',
                bgcolor: isDark ? 'rgba(246, 184, 91, .12)' : 'transparent',
              }}
            >
              {isDark ? <Sun size={17} /> : <Moon size={17} />}
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
