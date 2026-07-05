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
import { LogOut, Settings, ShieldCheck } from 'lucide-react'
import { useState } from 'react'

function AdminTopbar({ admin, onLogout }) {
  const [anchorEl, setAnchorEl] = useState(null)

  const handleCloseMenu = () => setAnchorEl(null)

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

          <IconButton
            size="small"
            title="Settings"
            onClick={(e) => setAnchorEl(e.currentTarget)}
          >
            <Settings size={17} />
          </IconButton>

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
