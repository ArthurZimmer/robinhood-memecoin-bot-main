// Minimal env so importing src modules (logger → config/env) doesn't exit(1)
// in unit tests. Import this file BEFORE any src import — ESM evaluates
// imports in order, so the side effect lands first.

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.ROBBINHOOD_RPC_URL ??= 'https://rpc.test.invalid'
process.env.UNISWAP_FACTORY_ADDRESS ??= '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f'
process.env.UNISWAP_ROUTER_ADDRESS ??= '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba'
process.env.WETH_ADDRESS ??= '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
process.env.TELEGRAM_BOT_TOKEN ??= 'test-token'
process.env.TELEGRAM_CHAT_ID ??= '0'

export {}
