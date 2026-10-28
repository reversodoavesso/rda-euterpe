"""Curation Engine and Workflow Models for Euterpe.

Implements the 12 dramaturgias (Escuta & Imagem v2.0), 25 eixos curatoriais,
10 coordenadas diegéticas, editorial models registry, and DAG validation
for the Visual Workflow Editor (Decisions 17A, 18B, 19A, 20A).
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Tuple

STEP_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")

VALID_STEP_KINDS = frozenset(
    {"briefing", "research", "selection", "sequencing", "review", "synthesis", "tool_gate", "approval_gate"}
)

VALID_ROLE_FUNCTIONS = frozenset(
    {"chat", "briefing", "research", "selection", "sequencing", "review", "synthesis", "vision", "image_edit"}
)

ALLOWED_EUTERPE_TOOLS = frozenset({
    "spotify_get_playlists",
    "spotify_get_playlist_tracks",
    "spotify_get_saved_tracks",
    "spotify_get_several_tracks",
    "spotify_search_spotify",
    "spotify_resolve_tracks",
    "spotify_create_playlist",
    "spotify_delete_playlist",
    "spotify_add_tracks",
    "spotify_remove_tracks",
    "spotify_replace_playlist_tracks",
    "spotify_set_playlist_details",
})

DRAMATURGIAS = [
    {
        "id": "montanha_russa",
        "name": "Montanha-Russa Clássica",
        "description": "Ascensão gradual, clímax central potente, respiro meditativo e catarse final resolutiva.",
        "pacing": "gradual-build",
        "arc": [0.2, 0.4, 0.7, 0.95, 0.5, 0.85, 0.3],
    },
    {
        "id": "transe_espiral",
        "name": "Transe Gravitacional / Espiral",
        "description": "Repetição hipnótica com adensamento tímbrico e rítmico cumulativo em espiral.",
        "pacing": "cumulative-dense",
        "arc": [0.4, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95],
    },
    {
        "id": "pendulo_duplo",
        "name": "Pêndulo / Duplo Ápice",
        "description": "Dois polos estéticos contrastantes oscilando com dois cumes de intensidade.",
        "pacing": "oscillating",
        "arc": [0.3, 0.8, 0.4, 0.85, 0.35, 0.7, 0.25],
    },
    {
        "id": "diptico_espelho",
        "name": "Díptico / Espelho Partido",
        "description": "Lado A luminoso e expansivo contrastando com um Lado B sombrio e introspectivo.",
        "pacing": "binary-split",
        "arc": [0.7, 0.75, 0.8, 0.3, 0.35, 0.4, 0.2],
    },
    {
        "id": "queda_livre",
        "name": "Queda Livre / Dissipação",
        "description": "Início em pico de alta voltagem, desacelerando até a quietude, o eco e o silêncio.",
        "pacing": "deceleration",
        "arc": [0.95, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1],
    },
    {
        "id": "ouroboros",
        "name": "Ouroboros / Rito Circular",
        "description": "Estrutura cíclica em que a última faixa devolve o ouvinte organicamente à primeira.",
        "pacing": "cyclic",
        "arc": [0.5, 0.6, 0.75, 0.9, 0.75, 0.6, 0.5],
    },
    {
        "id": "descongelamento",
        "name": "Descongelamento / Claridade",
        "description": "Abertura austera, fria e minimalista que desabrocha em calor tímbrico e polifonia.",
        "pacing": "thawing",
        "arc": [0.2, 0.3, 0.45, 0.6, 0.75, 0.85, 0.9],
    },
    {
        "id": "comunhao_quintal",
        "name": "Comunhão Circular / Quintal",
        "description": "Atmosfera intimista, violões de madeira, vozes coletivas e acolhimento orgânico.",
        "pacing": "warm-acoustic",
        "arc": [0.4, 0.5, 0.6, 0.65, 0.6, 0.55, 0.45],
    },
    {
        "id": "fenda_sismica",
        "name": "Fenda Sísmica / Ruptura",
        "description": "Continuidade aparentemente estável rompida abruptamente no centro por choque sonoro.",
        "pacing": "sudden-rupture",
        "arc": [0.5, 0.52, 0.98, 0.4, 0.6, 0.7, 0.5],
    },
    {
        "id": "mare_alta",
        "name": "Maré Alta Contínua",
        "description": "Sustentação prolongada de alta pulsação sem quedas bruscas de energia.",
        "pacing": "sustained-high",
        "arc": [0.8, 0.85, 0.88, 0.9, 0.87, 0.92, 0.85],
    },
    {
        "id": "espelho_concavo",
        "name": "Espelho Côncavo / Ponto Cego",
        "description": "Curvatura meditativa com deformação controlada do centro emocional e respiros.",
        "pacing": "inverted-curvature",
        "arc": [0.6, 0.4, 0.2, 0.15, 0.35, 0.55, 0.7],
    },
    {
        "id": "rapsodia_fractal",
        "name": "Rapsódia Fractal / Mosaico",
        "description": "Fragmentos aparentemente dispersos que revelam coesão geométrica profunda no conjunto.",
        "pacing": "fractal",
        "arc": [0.4, 0.7, 0.3, 0.85, 0.5, 0.9, 0.35],
    },
]

COORDENADAS_DIEGETICAS = [
    {"id": "territorio", "label": "Território / Geografia Cultural", "placeholder": "Ex: Vale do Jequitinhonha, Berlim oriental, sertão cósmico"},
    {"id": "clima", "label": "Estação do Ano / Clima", "placeholder": "Ex: Garoa de inverno, tarde seca de agosto, neblina matinal"},
    {"id": "luz", "label": "Hora do Dia / Qualidade da Luz", "placeholder": "Ex: Hora azul crepuscular, breu total, meio-dia ofuscante"},
    {"id": "espaco", "label": "Espaço Físico", "placeholder": "Ex: Quarto de teto alto, estrada litorânea vazia, galpão industrial"},
    {"id": "somatismo", "label": "Estado Somático / Pulso Corporal", "placeholder": "Ex: Respiração funda e lenta, pés descalços, taquicardia sutil"},
    {"id": "silencio", "label": "Presença do Silêncio", "placeholder": "Ex: Ar rarefeito, reverberação ampla, respiros entre faixas"},
    {"id": "velocidade", "label": "Vetor de Velocidade", "placeholder": "Ex: Deriva lenta, marcha fúnebre, arrancada constante"},
    {"id": "temperatura", "label": "Temperatura Tímbrica", "placeholder": "Ex: Válvula analógica quente, metal gelado, sopro de madeira"},
    {"id": "atrito", "label": "Atrito / Ruído / Textura", "placeholder": "Ex: Grão de fita cassete, vinil com poeira, estalido limpo"},
    {"id": "transcendencia", "label": "Horizonte / Transcendência", "placeholder": "Ex: Oração laica, desapego material, reverência telúrica"},
]

EIXOS_CURATORIAIS = [
    {"id": "E01", "name": "Densidade Tímbrica", "range": [1, 10]},
    {"id": "E02", "name": "Textura Acústica vs. Sintética", "range": [1, 10]},
    {"id": "E03", "name": "Pulso e Síncope Rítmica", "range": [1, 10]},
    {"id": "E04", "name": "Tensão Harmônica", "range": [1, 10]},
    {"id": "E05", "name": "Presença Vocal e Idioma", "range": [1, 10]},
    {"id": "E06", "name": "Espacialidade e Reverb", "range": [1, 10]},
    {"id": "E07", "name": "Respiro Dinâmico", "range": [1, 10]},
    {"id": "E08", "name": "Arqueologia Afetiva / Memória", "range": [1, 10]},
    {"id": "E09", "name": "Curvatura Melódica", "range": [1, 10]},
    {"id": "E10", "name": "Contraste de Transição", "range": [1, 10]},
]

EDITORIAL_MODELS = [
    {
        "id": "escuta-e-imagem-v2",
        "name": "Escuta & Imagem v2.0",
        "description": "Metodologia autoral completa com 12 dramaturgias, 10 coordenadas diegéticas e 25 eixos sonoros.",
        "badge": "Metodologia Autoral",
        "recommended_profile": "aprofundado",
        "default_steps": [
            {"id": "briefing", "kind": "briefing", "label": "Coordenadas & Briefing", "role_function": "briefing", "model_alias": "rda/reasoning", "pos": {"x": 80, "y": 140}},
            {"id": "garimpo", "kind": "research", "label": "Garimpo do Acervo", "role_function": "research", "model_alias": "rda/fast", "pos": {"x": 320, "y": 140}, "tools": ["spotify_get_saved_tracks", "spotify_search_spotify"]},
            {"id": "selecao", "kind": "selection", "label": "Filtragem Curatorial", "role_function": "selection", "model_alias": "rda/chat-default", "pos": {"x": 560, "y": 140}, "tools": ["spotify_resolve_tracks", "spotify_get_several_tracks"]},
            {"id": "dramaturgia", "kind": "sequencing", "label": "Arco Dramatúrgico", "role_function": "sequencing", "model_alias": "rda/reasoning", "pos": {"x": 800, "y": 140}},
            {"id": "revisao", "kind": "review", "label": "Auditoria de Respiro & Eixos", "role_function": "review", "model_alias": "rda/chat-default", "pos": {"x": 1040, "y": 140}},
            {"id": "publicacao", "kind": "approval_gate", "label": "Aprovação & Publicação", "role_function": "synthesis", "requires_approval": True, "pos": {"x": 1280, "y": 140}, "tools": ["spotify_create_playlist", "spotify_replace_playlist_tracks", "spotify_set_playlist_details"]},
        ],
        "default_edges": [
            {"id": "e1", "source": "briefing", "target": "garimpo"},
            {"id": "e2", "source": "garimpo", "target": "selecao"},
            {"id": "e3", "source": "selecao", "target": "dramaturgia"},
            {"id": "e4", "source": "dramaturgia", "target": "revisao"},
            {"id": "e5", "source": "revisao", "target": "publicacao"},
        ],
    },
    {
        "id": "curadoria-livre",
        "name": "Curadoria Livre",
        "description": "Seleção assistida dinâmica sem dramaturgia rígida, ideal para playlists temáticas ágeis.",
        "badge": "Ágil",
        "recommended_profile": "equilibrado",
        "default_steps": [
            {"id": "briefing", "kind": "briefing", "label": "Briefing Livre", "role_function": "briefing", "model_alias": "rda/chat-default", "pos": {"x": 100, "y": 150}},
            {"id": "busca", "kind": "research", "label": "Busca & Resolução", "role_function": "research", "model_alias": "rda/fast", "pos": {"x": 380, "y": 150}, "tools": ["spotify_search_spotify", "spotify_resolve_tracks"]},
            {"id": "sequenciamento", "kind": "sequencing", "label": "Sequência Balanceada", "role_function": "sequencing", "model_alias": "rda/chat-default", "pos": {"x": 660, "y": 150}},
            {"id": "publicar", "kind": "approval_gate", "label": "Aprovação Humana", "role_function": "synthesis", "requires_approval": True, "pos": {"x": 940, "y": 150}, "tools": ["spotify_create_playlist", "spotify_add_tracks"]},
        ],
        "default_edges": [
            {"id": "e1", "source": "briefing", "target": "busca"},
            {"id": "e2", "source": "busca", "target": "sequenciamento"},
            {"id": "e3", "source": "sequenciamento", "target": "publicar"},
        ],
    },
    {
        "id": "revisao-existente",
        "name": "Revisão de Playlist Existente",
        "description": "Diagnostica faixas desativadas, repetidas ou desarmônicas em uma playlist conectada e propõe refatoração.",
        "badge": "Manutenção",
        "recommended_profile": "equilibrado",
        "default_steps": [
            {"id": "leitura", "kind": "research", "label": "Leitura da Playlist", "role_function": "research", "model_alias": "rda/fast", "pos": {"x": 100, "y": 150}, "tools": ["spotify_get_playlist_tracks", "spotify_get_several_tracks"]},
            {"id": "diagnostico", "kind": "review", "label": "Diagnóstico de Órfãos & Ordem", "role_function": "review", "model_alias": "rda/reasoning", "pos": {"x": 420, "y": 150}},
            {"id": "reparo", "kind": "approval_gate", "label": "Aprovação de Atualização", "role_function": "synthesis", "requires_approval": True, "pos": {"x": 740, "y": 150}, "tools": ["spotify_replace_playlist_tracks", "spotify_set_playlist_details"]},
        ],
        "default_edges": [
            {"id": "e1", "source": "leitura", "target": "diagnostico"},
            {"id": "e2", "source": "diagnostico", "target": "reparo"},
        ],
    },
    {
        "id": "descoberta-garimpo",
        "name": "Descoberta & Garimpo",
        "description": "Recupera pérolas esquecidas do acervo e cruza com novidades de artistas afins.",
        "badge": "Descoberta",
        "recommended_profile": "aprofundado",
        "default_steps": [
            {"id": "acervo", "kind": "research", "label": "Leitura de Curtidas", "role_function": "research", "model_alias": "rda/fast", "pos": {"x": 100, "y": 150}, "tools": ["spotify_get_saved_tracks"]},
            {"id": "variacao", "kind": "selection", "label": "Variação de Artistas", "role_function": "selection", "model_alias": "rda/reasoning", "pos": {"x": 420, "y": 150}, "tools": ["spotify_search_spotify", "spotify_resolve_tracks"]},
            {"id": "fechamento", "kind": "approval_gate", "label": "Aprovação de Descoberta", "role_function": "synthesis", "requires_approval": True, "pos": {"x": 740, "y": 150}, "tools": ["spotify_create_playlist", "spotify_add_tracks"]},
        ],
        "default_edges": [
            {"id": "e1", "source": "acervo", "target": "variacao"},
            {"id": "e2", "source": "variacao", "target": "fechamento"},
        ],
    },
]


def validate_dag(steps: List[Dict[str, Any]], edges: List[Dict[str, Any]]) -> Tuple[bool, List[str], Optional[str]]:
    """
    Validates a workflow graph: checks step existence, ports, and absence of cycles (DAG).
    Returns (is_valid, topological_order, error_message).
    """
    if not steps:
        return False, [], "O fluxo precisa conter ao menos uma etapa."

    step_ids = set()
    for s in steps:
        sid = s.get("id")
        if not sid or not STEP_ID_RE.match(sid):
            return False, [], f"ID de etapa inválido: '{sid}'"
        if sid in step_ids:
            return False, [], f"ID de etapa duplicado: '{sid}'"
        step_ids.add(sid)

    adj: Dict[str, List[str]] = {sid: [] for sid in step_ids}
    in_degree: Dict[str, int] = {sid: 0 for sid in step_ids}

    for e in edges:
        src = e.get("source")
        tgt = e.get("target")
        if not src or src not in step_ids:
            return False, [], f"Conexão inválida com origem desconhecida: '{src}'"
        if not tgt or tgt not in step_ids:
            return False, [], f"Conexão inválida com destino desconhecido: '{tgt}'"
        if src == tgt:
            return False, [], f"Ciclo detectado: etapa '{src}' conecta a si mesma."

        adj[src].append(tgt)
        in_degree[tgt] += 1

    # Kahn's topological sort
    queue = [sid for sid in step_ids if in_degree[sid] == 0]
    order: List[str] = []
    while queue:
        curr = queue.pop(0)
        order.append(curr)
        for nxt in adj[curr]:
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                queue.append(nxt)

    if len(order) != len(step_ids):
        return False, [], "Ciclo de dependência detectado no grafo de fluxo. Corrija as conexões para manter um fluxo acíclico."

    return True, order, None


def compute_approval_hash(user_id: str, domain_id: str, action_type: str, payload: Mapping[str, Any]) -> str:
    """Computes single-use payload hash for mutation approvals (Decision 17A)."""
    canonical = json.dumps(
        {
            "user_id": user_id,
            "domain_id": domain_id,
            "action_type": action_type,
            "payload": payload,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()
