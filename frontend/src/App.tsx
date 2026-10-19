import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import AskPage from "./pages/AskPage";
import EvalsPage from "./pages/EvalsPage";
import LoginPage from "./pages/LoginPage";
import QueryPage from "./pages/QueryPage";
import SemanticPage from "./pages/SemanticPage";
import TracesPage from "./pages/TracesPage";

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="empty">加载中…</div>;
  if (!user) return <LoginPage />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/ask" element={<AskPage />} />
        <Route path="/ask/:conversationId" element={<AskPage />} />
        <Route path="/semantic" element={<SemanticPage />} />
        <Route path="/evals" element={<EvalsPage />} />
        <Route path="/traces" element={<TracesPage />} />
        <Route path="/traces/:runId" element={<TracesPage />} />
        <Route path="/q/:queryId" element={<QueryPage />} />
        <Route path="*" element={<Navigate to="/ask" replace />} />
      </Route>
    </Routes>
  );
}
