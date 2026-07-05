import { Box, Paper, Typography } from '@mui/material'
import { Hammer } from 'lucide-react'

// Placeholder renders a "coming soon" panel for admin routes whose real pages
// are built in later steps. Keeps every sidebar link resolvable meanwhile.
export default function Placeholder({ title }) {
  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>{title}</Typography>
      <Paper sx={{ p: 3, display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.secondary' }}>
        <Hammer size={18} />
        <Typography>This section is coming in a later step.</Typography>
      </Paper>
    </Box>
  )
}
