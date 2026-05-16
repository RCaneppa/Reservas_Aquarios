# 🌴 Aquárius Reservas — Protótipo

Sistema de reservas de espaços do **Aquárius Clube de Campo** (protótipo funcional para apresentação à diretoria).

## ✨ Funcionalidades implementadas

- ✅ Login por matrícula/senha (perfil sócio + admin)
- ✅ 9 Churrasqueiras + Salão de Festas (reserva por **período**: Diurno/Noturno)
- ✅ Campo de Futebol + Quadra de Areia (reserva por **hora**: 07h–22h)
- ✅ Calendário de disponibilidade em tempo real
- ✅ Termo de aceite obrigatório (3 artigos com checkboxes)
- ✅ Política progressiva de infração (30% / 60% / 100% sobre R$ 92,00) com bloqueio de 30 dias
- ✅ Reset após 1 ano sem infrações
- ✅ Limite de 2 churrasqueiras simultâneas por sócio/período
- ✅ Churrasqueiras 4+5 e 6+7 conjugadas (informativo)
- ✅ Validação de adimplência (>90 dias = bloqueio)
- ✅ Prazo de cancelamento: 09:00 (Diurno) / 17:00 (Noturno)
- ✅ Taxa de limpeza do Salão (R$ 70,00)
- ✅ Clube fechado às segundas (limpeza/manutenção)
- ✅ Painel admin: KPIs, reservas, sócios, infrações, audit log
- ✅ Audit log completo (LGPD)

## 🚀 Como rodar localmente

```bash
npm install
npm start
```

Acesse: http://localhost:3000

### Acessos demo

| Perfil               | Matrícula | Senha     |
|----------------------|-----------|-----------|
| Administrador        | 0001      | admin123  |
| Sócio                | 1001      | 123456    |
| Sócia                | 1002      | 123456    |
| Sócio                | 1003      | 123456    |
| Sócia (inadimplente) | 1004      | 123456    |

## 🌐 Publicação online (Render.com — grátis)

1. Crie conta em https://render.com
2. Suba este projeto em um repositório GitHub
3. No Render: **New +** → **Blueprint** → aponte para o repositório
4. O `render.yaml` já está configurado. Em ~3 min você terá uma URL pública.

> ⚠️ Free tier do Render usa filesystem efêmero — após 15min ocioso o serviço hiberna e o SQLite reinicia com os dados de seed. Para produção real, migrar para Postgres (Render oferece grátis).

## 🛠️ Stack

- Backend: Node.js 18 + Express
- Banco: SQLite (better-sqlite3)
- Sessões: express-session
- Hash de senha: bcryptjs
- Frontend: HTML5 + CSS3 + JS vanilla (sem framework)

## 📁 Estrutura

```
.
├── server.js          # API REST (Express)
├── db.js              # Schema + seed SQLite
├── regras.js          # Regras de negócio (reservas, infrações, prazos)
├── package.json
├── render.yaml        # Deploy Render.com
├── public/
│   ├── index.html     # Login
│   ├── socio.html     # Painel do sócio
│   ├── admin.html     # Painel da diretoria
│   ├── css/style.css
│   └── js/
│       ├── socio.js
│       └── admin.js
└── data/aquarius.db   # SQLite (gerado em runtime)
```

## 🔮 Próximos passos (pós-aprovação da diretoria)

- [ ] Integração WhatsApp Business API (bot de reservas)
- [ ] Notificações por e-mail / SMS de confirmação
- [ ] Cadastro real de sócios (integração com sistema do clube)
- [ ] Pagamento online da taxa de limpeza (Pix)
- [ ] Migrar SQLite → PostgreSQL
- [ ] Relatórios mensais de ocupação (exportar CSV/PDF)
- [ ] App mobile (PWA)
