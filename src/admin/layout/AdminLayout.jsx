import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import AdminTopbar from '../components/AdminTopbar'
import AdminSidebar from '../components/AdminSidebar'
import EnterTrade from '../tradepanel/EnterTrade'

// AdminLayout is the app shell. It keeps the Enter Trade panel MOUNTED across
// route changes (hidden, not unmounted) once visited, so its live websocket feed
// and loaded option chain survive navigating away and back — the same keepalive
// pattern as the Admin_project.
function AdminLayout({ admin, themeMode, onToggleTheme }) {
  const location = useLocation()
  const isEnterTradeRoute = location.pathname === '/admin/trade-panel/enter-trade'
  const [keepEnterTrade, setKeepEnterTrade] = useState(isEnterTradeRoute)

  useEffect(() => {
    if (isEnterTradeRoute) setKeepEnterTrade(true)
  }, [isEnterTradeRoute])

  return (
    <div className="app-shell">
      <AdminTopbar admin={admin} themeMode={themeMode} onToggleTheme={onToggleTheme} />
      <div className="app-body">
        <AdminSidebar />
        <main className="app-main">
          {keepEnterTrade && (
            <div className="trade-panel-keepalive" style={{ display: isEnterTradeRoute ? 'block' : 'none' }}>
              <EnterTrade />
            </div>
          )}
          <div style={{ display: isEnterTradeRoute ? 'none' : 'block' }}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

export default AdminLayout
