import { Loader2, Plus, Trash2, X } from "lucide-react";
import type { WakeWordModelMetadata } from "../../../../src/shared/types.ts";
import { resolveWakeWordModelWakeWord } from "../../../../src/shared/wake-word-settings.ts";
import { formatBytes, formatImportedAt } from "../../formatters.ts";

export function WakeModelModal({
	models,
	activeId,
	busy,
	status,
	onClose,
	onImport,
	onSwitch,
	onDelete,
}: {
	models: WakeWordModelMetadata[];
	activeId: string | undefined;
	busy: boolean;
	status: string;
	onClose: () => void;
	onImport: () => void;
	onSwitch: (model: WakeWordModelMetadata) => void;
	onDelete: (id: string) => void;
}) {
	return (
		<div className="cache-modal-backdrop" role="presentation" onClick={onClose}>
			<section className="cache-modal" role="dialog" aria-modal="true" aria-label="openWakeWord 模型" onClick={(event) => event.stopPropagation()}>
				<header className="cache-modal-head">
					<div>
						<span className="cache-kicker">openWakeWord Models</span>
						<h2>唤醒词模型</h2>
						<p>导入 .onnx 模型并选择当前生效的唤醒词。唤醒词来自模型文件名。</p>
					</div>
					<button className="title-btn danger" type="button" onClick={onClose} aria-label="关闭">
						<X size={15} />
					</button>
				</header>
				<div className="cache-modal-actions">
					<button className="primary-btn" type="button" onClick={onImport} disabled={busy}>
						{busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
						<span>导入模型</span>
					</button>
				</div>
				{status ? <div className="cache-status">{status}</div> : null}
				<div className="wake-model-list" style={{ marginTop: 12 }}>
					{models.length === 0 ? (
						<div className="cache-empty">尚未导入 openWakeWord 模型。点「导入模型」选择 .onnx 文件。</div>
					) : (
						models.map((model) => {
							const active = model.id === activeId;
							return (
								<div className={`wake-model-item ${active ? "active" : ""}`} key={model.id}>
									<button type="button" onClick={() => onSwitch(model)} disabled={busy}>
										<strong>{model.label}</strong>
										<small>
											{resolveWakeWordModelWakeWord(model)} · {formatBytes(model.sizeBytes)} · {formatImportedAt(model.importedAt)}
										</small>
									</button>
									<button type="button" className="wake-model-delete" aria-label={`删除 ${model.label}`} title="删除模型" onClick={() => onDelete(model.id)} disabled={busy}>
										<Trash2 size={13} />
									</button>
								</div>
							);
						})
					)}
				</div>
			</section>
		</div>
	);
}
