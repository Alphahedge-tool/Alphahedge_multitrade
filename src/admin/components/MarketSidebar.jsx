import { useState } from 'react'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material'
import {
  Activity,
  ChevronDown,
  LineChart,
  PanelRightClose,
  PanelRightOpen,
  Waves,
} from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

const STORAGE_KEY = 'alphahedge-market-sidebar-open'

function initialOpenState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === null ? true : saved === 'true'
  } catch {
    return true
  }
}

// Right-side shell for market information and model navigation. It mirrors the
// left AdminSidebar's design system (icon wrappers, active/hover states,
// accordion grouping) so the two rails read as one app — just flipped to the
// right edge (borderLeft, PanelRight icons, its own collapse state).
export default function MarketSidebar() {
  const location = useLocation()
  const [open, setOpen] = useState(initialOpenState)
  const [marketOpen, setMarketOpen] = useState(true)

  const isMarketRoute = location.pathname.startsWith('/admin/market')

  const updateOpen = (next) => {
    setOpen(next)
    try { localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore storage failures */ }
  }

  const NavIcon = ({ children }) => (
    <Box sx={{ display: 'inline-flex', width: 18, height: 18, alignItems: 'center', justifyContent: 'center', flex: 'none' }}>
      {children}
    </Box>
  )

  const navSx = (path, nested = false) => {
    const active = location.pathname === path
    return {
      minHeight: 36,
      mx: 1,
      my: 0.25,
      pl: nested ? 4.5 : 1.5,
      pr: 1,
      gap: 1,
      borderRadius: 1,
      color: active ? 'primary.main' : 'text.secondary',
      bgcolor: active ? 'primary.light' : 'transparent',
      '&:hover': {
        bgcolor: active ? 'primary.light' : 'var(--ao-hover)',
        color: active ? 'primary.main' : 'text.primary',
      },
      '& .MuiListItemText-primary': {
        fontSize: '0.8125rem',
        fontWeight: active ? 700 : 600,
      },
    }
  }

  const summarySx = (active) => ({
    minHeight: 38,
    mx: 1,
    my: 0.25,
    px: 1.5,
    borderRadius: 1,
    color: active ? 'primary.main' : 'text.secondary',
    bgcolor: active ? 'primary.light' : 'transparent',
    '&:hover': { bgcolor: active ? 'primary.light' : 'var(--ao-hover)' },
    '& .MuiAccordionSummary-content': {
      alignItems: 'center',
      gap: 1,
      margin: 0,
    },
    '& .MuiListItemText-primary': {
      fontSize: '0.8125rem',
      fontWeight: 700,
    },
  })

  return (
    <Box
      component="aside"
      aria-label="Market information sidebar"
      sx={{
        width: open ? 232 : 46,
        minWidth: open ? 232 : 46,
        flexShrink: 0,
        height: '100%',
        overflow: 'hidden',
        borderLeft: '1px solid var(--ao-border-soft)',
        background: 'var(--ao-surface)',
        zIndex: 20,
      }}
    >
      {!open && (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 1 }}>
        <IconButton
          size="small"
          title="Open market sidebar"
          aria-label="Open market sidebar"
          onClick={() => updateOpen(true)}
        >
          <PanelRightOpen size={17} />
        </IconButton>
      </Box>
      )}

      {open && (
      <>
      <Box sx={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', px: 1, pb: 0.75 }}>
        <IconButton
          size="small"
          title="Close market sidebar"
          aria-label="Close market sidebar"
          onClick={() => updateOpen(false)}
        >
          <PanelRightClose size={17} />
        </IconButton>
      </Box>
      <List sx={{ p: 0 }}>
        <Accordion
          expanded={marketOpen || isMarketRoute}
          onChange={() => setMarketOpen(!marketOpen)}
          elevation={0}
          disableGutters
          square
          sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}
        >
          <AccordionSummary expandIcon={<ChevronDown size={15} />} sx={summarySx(isMarketRoute)}>
            <NavIcon><LineChart size={16} /></NavIcon>
            <ListItemText primary="Market Intelligence" />
          </AccordionSummary>

          <AccordionDetails sx={{ p: 0 }}>
            <List component="div" disablePadding>
              <ListItemButton
                component={Link}
                to="/admin/market/oi-premium-decay"
                sx={navSx('/admin/market/oi-premium-decay', true)}
              >
                <NavIcon><Activity size={15} /></NavIcon>
                <ListItemText primary="OI / Premium Decay" />
              </ListItemButton>

              <ListItemButton
                component={Link}
                to="/admin/market/rolling-straddle"
                sx={navSx('/admin/market/rolling-straddle', true)}
              >
                <NavIcon><Waves size={15} /></NavIcon>
                <ListItemText primary="Rolling Straddle" />
              </ListItemButton>
            </List>
          </AccordionDetails>
        </Accordion>
      </List>
      </>
      )}
    </Box>
  )
}
