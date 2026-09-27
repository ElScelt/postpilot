export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// The canonical production origin, without a trailing slash.
export function appUrl() {
  return required("APP_URL").replace(/\/$/, "");
}
