import { connectPath } from "@/lib/linkedin/oauth";

export default function Home() {
  return (
    <main style={{ font: "15px/1.5 system-ui, sans-serif", margin: "0 auto", padding: "2rem", maxWidth: "40rem" }}>
      <h1>postpilot</h1>
      <p>Grounded LinkedIn posts on a schedule, drafted overnight and reviewed from your phone.</p>
      <ul>
        <li><a href="/dashboard">Dashboard</a>: authorization, next run, posts and run history.</li>
        <li><a href={connectPath}>Connect LinkedIn</a>: run once, and again before the authorization expires.</li>
      </ul>
    </main>
  );
}
