import { Box, Typography } from '@mui/material'
import OptionChain from './OptionChain'
import './tradepanel.css'

// Option Chain page — no account picker. The chain reads from the shared feed
// (the Angel + Upstox accounts logged in via Feed Master). Just pick underlying
// + expiry and load.
export default function OptionChainPage() {
  return (
    <Box className="page-shell">
      <Box sx={{ mb: 1.5 }}>
        <Typography variant="h5">Option Chain</Typography>
        <Typography color="text.secondary" fontSize="0.875rem">
          Powered by the Feed Master — Angel LTP / OI enriched with Upstox Bid / Ask. No account selection needed here.
        </Typography>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <OptionChain />
      </Box>
    </Box>
  )
}
