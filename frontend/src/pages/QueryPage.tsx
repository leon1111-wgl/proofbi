import { useParams } from "react-router-dom";
import { ProvenanceView } from "../components/Provenance";

/** Standalone provenance page: the target of the links in the WeCom daily report. */
export default function QueryPage() {
  const { queryId } = useParams();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>数字溯源</h1>
          <p>查询 {queryId} 的 SQL、执行信息与结果行。可以重新执行并比对结果指纹，确认数字可以复现。</p>
        </div>
      </div>
      <div className="card" style={{ maxWidth: 920 }}>
        {queryId && <ProvenanceView queryId={queryId} />}
      </div>
    </div>
  );
}
