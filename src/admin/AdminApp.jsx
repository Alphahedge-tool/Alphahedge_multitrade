import { HashRouter, Routes, Route, Navigate } from 'react-router-dom'
import { CssBaseline, ThemeProvider } from '@mui/material'
import { LocalizationProvider } from '@mui/x-date-pickers'
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs'

import { adminTheme } from './theme'
import AdminLayout from './layout/AdminLayout'
import AdminDashboard from './pages/AdminDashboard'
import UsersPage from './pages/UsersPage'
import Feedmaster from './pages/Feedmaster'
import GetPositions from './tradepanel/GetPositions'
import GetOrderBook from './tradepanel/GetOrderBook'
import OptionChainPage from './tradepanel/OptionChainPage'
import Placeholder from './pages/Placeholder'
import './admin.css'
import './tradepanel/tradepanel.css'

// AdminApp is the admin UI shell entry point: MUI theme + date-picker provider,
// the router, and the routes. Pages not yet built render a Placeholder so the
// sidebar links all resolve without crashing (they get filled in later steps).
export default function AdminApp() {
  const admin = { username: 'Admin' }

  return (
    <ThemeProvider theme={adminTheme}>
      <CssBaseline />
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <HashRouter>
          <Routes>
            <Route path="/" element={<Navigate to="/admin" replace />} />
            <Route path="/admin" element={<AdminLayout admin={admin} />}>
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="masters/stocks" element={<Placeholder title="Stocks Master" />} />
              <Route path="masters/mutual-funds" element={<Placeholder title="MF Master" />} />
              <Route path="masters/brokers" element={<Placeholder title="Broker Master" />} />
              <Route path="masters/feedmaster" element={<Feedmaster />} />
              <Route path="transactions/user-balances" element={<Placeholder title="User Balances" />} />
              <Route path="transactions/sync-net-positions" element={<Placeholder title="Sync Net Positions" />} />
              {/* Enter Trade is rendered by the layout keepalive (stays mounted
                  for the live feed); this route is just the address for it. */}
              <Route path="trade-panel/enter-trade" element={null} />
              <Route path="trade-panel/option-chain" element={<OptionChainPage />} />
              <Route path="trade-panel/orderbook" element={<GetOrderBook />} />
              <Route path="trade-panel/positions" element={<GetPositions />} />
              <Route path="trade-panel" element={<Navigate to="/admin/trade-panel/enter-trade" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Routes>
        </HashRouter>
      </LocalizationProvider>
    </ThemeProvider>
  )
}
