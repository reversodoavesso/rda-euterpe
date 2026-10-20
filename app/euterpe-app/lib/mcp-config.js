// O daemon informa seu executável real; a UI não presume plataforma ou pasta.
export function stdioSnippet(info) {
  const server = { command: info?.executable || 'euterpe', args: ['mcp', '--stdio'] };
  if (info?.dataDir) server.env = { EUTERPE_DATA_DIR: info.dataDir };
  return JSON.stringify({ mcpServers: { euterpe: server } }, null, 2);
}
