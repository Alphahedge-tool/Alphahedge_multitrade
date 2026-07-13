export default function BrokerOrderBar({
  users, userId, setUserId, configs, configId, setConfigId, client, status,
}) {
  return (
    <div className="trade-account-bar" aria-label="Order account">
      <label>
        Order User
        <select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">Select user</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>{user.username || `User ${user.id}`}</option>
          ))}
        </select>
      </label>
      <label>
        Order Broker Account
        <select value={configId} onChange={(event) => setConfigId(event.target.value)} disabled={!configs.length}>
          <option value="">Select account</option>
          {configs.map((config) => (
            <option key={config.id} value={config.id}>
              {config.broker_name} — {config.account_id || config.id}
            </option>
          ))}
        </select>
      </label>
      <span className={`trade-account-status${client?.loggedIn ? ' is-live' : ''}`}>
        {status}
      </span>
    </div>
  );
}
