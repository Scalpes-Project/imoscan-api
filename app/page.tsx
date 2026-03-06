// app/page.tsx
export default function Home() {
  return (
    <div style={{ fontFamily: "monospace", padding: "40px", background: "#060606", color: "#C8956C", minHeight: "100vh" }}>
      <h1>IMOSCAN API</h1>
      <p style={{ color: "#808080" }}>Le vendeur promet. IMOSCAN prouve.</p>
      <br />
      <p style={{ color: "#505050", fontSize: "13px" }}>
        POST /api/analyze<br />
        Body: {"{"} normalizedText: string, mode: "COMPACT" | "DOSSIER" {"}"}
      </p>
      <p style={{ color: "#3DBB8A", fontSize: "13px", marginTop: "20px" }}>
        ✓ Engine running — V3.2 PROD
      </p>
    </div>
  );
}
