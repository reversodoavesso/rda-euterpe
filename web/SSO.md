# Login RDA no Euterpe Web

O gateway Web integra o Zitadel RDA por Authorization Code com PKCE. A identidade do access token é verificada por `https://auth.reversodoavesso.com/api/auth/verify`, que consulta o núcleo canônico. Tokens permanecem em memória no gateway; cookies contêm somente a sessão opaca.

## Configuração

- `WEB_SSO_ENABLED=true`
- `WEB_PUBLIC_ORIGIN`: origem exata publicada, HTTPS em produção. A instalação local aceita `http://127.0.0.1:18339`.
- `WEB_SSO_CLIENT_ID`: cliente cadastrado para essa origem.
- `RDA_SSO_PROJECT_ID`: projeto canônico RDA.
- `WEB_SSO_CLIENT_SECRET_FILE`: arquivo privado montado somente para leitura, para cliente Web confidencial. O cliente público de loopback usa PKCE sem segredo.
- `WEB_COOKIE_SECURE=1` em produção HTTPS.

Cadastre o callback exato `<origem>/api/account/sso/callback`. Não reutilize o cliente de produção no loopback. Use um override privado do Compose para configuração, imagem e montagem do segredo; não envie esse arquivo ou o banco `/data/accounts.sqlite` para o Git.

Nesta instalação local, a configuração ativa está em `headless-lab/private/web/sso.override.json`. Para mantê-la após reconstruções:

```sh
docker compose -f headless-lab/compose.web.yml -f headless-lab/private/web/sso.override.json up -d --no-build web
```

## Contas existentes

Faça backup do SQLite e dos diretórios privados antes de ativar SSO. As tabelas adicionais são criadas sem recriar usuários ou mover arquivos.

Quem já usa uma conta local deve entrar com ela e selecionar **Ajustes → Vincular conta RDA**. A vinculação exige a sessão local ainda válida, CSRF e o login RDA. Ela preserva o ID e o número interno da conta, conversas, preferências, arquivos e conexão Spotify. Depois do vínculo, use **Entrar com RDA**: a senha local, sessões antigas e links de acesso não autenticam mais essa conta.

Não vinculamos por e-mail ou nome. Entrar com RDA sem comprovar uma conta local cria um espaço separado quando a identidade ainda não possui vínculo. Conflitos entre contas são recusados.

O cadastro local fica desativado quando SSO está ativo; contas locais ainda não vinculadas continuam podendo entrar para efetuar a migração. Reiniciar o gateway exige novo login das contas vinculadas, pois os tokens não são persistidos no disco.

## Validação

Na pasta `web`, execute `python -m unittest discover -p 'test_*.py'` e `npm test`. Os testes verificam PKCE, state de uso único, emissor, revogação, propriedade de dados, vínculo explícito, aposentadoria de credenciais antigas e a interface de migração. O canário do repositório RDA também valida o fluxo contra o provedor real, usando somente uma conta sintética.

O cliente `RDA Euterpe Web` foi cadastrado para uma implantação futura em `https://euterpe.reversodoavesso.com`; o cadastro por si só não publica o aplicativo. A implantação validada em 27/10/2026 é local.
