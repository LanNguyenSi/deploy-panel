export interface Config {
  apiUrl: string;
  apiKey: string;
}

export function loadConfig(): Config {
  const apiUrl = process.env.DEPLOY_PANEL_URL;
  const apiKey = process.env.DEPLOY_PANEL_API_KEY;

  if (!apiUrl) {
    console.error("DEPLOY_PANEL_URL environment variable is required");
    process.exit(1);
  }

  if (!apiKey) {
    console.error("DEPLOY_PANEL_API_KEY environment variable is required");
    process.exit(1);
  }

  return { apiUrl: apiUrl.replace(/\/$/, ""), apiKey };
}
