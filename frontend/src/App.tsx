import { Navigate, Route, Routes } from "react-router-dom";
import { DEMO } from "./api";
import { useAuth } from "./auth";
import Layout, { DemoBanner } from "./components/Layout";
import AskPage from "./pages/AskPage";
import EvalsPage from "./pages/EvalsPage";
import Landing from "./pages/Landing";
import LoginPage from "./pages/LoginPage";
import QueryPage from "./pages/QueryPage";
import SemanticPage from "./pages/SemanticPage";
import TracesPage from "./pages/TracesPage";

export default function App() {
  const { user, loading } = useAuth();
  return (
    <>
      {DEMO && <DemoBanner />}
      <div className="app-body">
        {loading ? (
          <div className="empty">加载中…</div>
        ) : (
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={user ? <Navigate to="/ask" replace /> : <LoginPage />} />
            {/* console routes: signed-out visitors see the sign-in page at the same URL, so deep links survive */}
            <Route element={user ? <Layout /> : <LoginPage />}>
              <Route path="/ask" element={<AskPage />} />
              <Route path="/ask/:conversationId" element={<AskPage />} />
              <Route path="/semantic" element={<SemanticPage />} />
              <Route path="/evals" element={<EvalsPage />} />
              <Route path="/traces" element={<TracesPage />} />
              <Route path="/traces/:runId" element={<TracesPage />} />
              <Route path="/q/:queryId" element={<QueryPage />} />
            </Route>
            <Route path="*" element={<Navigate to={user ? "/ask" : "/"} replace />} />
          </Routes>
        )}
      </div>
    </>
  );
}
