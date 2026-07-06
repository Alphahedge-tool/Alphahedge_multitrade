import { Box, Chip, Typography } from '@mui/material'
import OptionChain from './OptionChain'
import './tradepanel.css'

// Fixed-height page shell: the header and controls stay visible, only the table scrolls.
export default function OptionChainPage() {
  return (
    <Box className="oc-page">
      <Box className="oc-page-head">
        <Box className="oc-page-title">
          <Box>
            <Typography variant="h5">Option Chain</Typography>
            <Typography color="text.secondary" fontSize="0.875rem">
              Angel LTP / OI enriched with Upstox Bid / Ask from Feed Master.
            </Typography>
          </Box>
          <Box className="oc-page-badges">
            <Chip size="small" label="Live chain" />
            <Chip size="small" variant="outlined" label="No account picker" />
          </Box>
        </Box>
      </Box>
      <OptionChain />
    </Box>
  )
}
