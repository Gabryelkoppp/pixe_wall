# Pixel Wall

Mural de pixels colaborativo, feito para demonstrar o **Docker**. Cada pessoa abre a página no celular ou no computador, escolhe uma cor, marca alguns quadradinhos e pinta. Todo mundo vê o mural mudar em tempo real.

## O que roda (4 containers)

| Serviço | Para que serve |
|---|---|
| `nginx` | Porta de entrada (8080) e balanceador entre as réplicas da API |
| `app` | API Node.js + WebSocket + a página (pode ter várias réplicas) |
| `cache` | Redis: guarda o mural, o tempo de espera e sincroniza as réplicas |
| `db` | PostgreSQL: histórico dos murais e de cada pixel pintado |

## Requisitos

- [Docker](https://docs.docker.com/get-docker/) com Compose v2 (Docker Desktop no Windows/Mac)
- Git

Não precisa instalar Node, Redis nem Postgres.

## Instalar e rodar

```bash
git clone https://github.com/Gabryelkoppp/pixe_wall.git
cd pixe_wall
cp .env.example .env        # Windows (PowerShell): copy .env.example .env
docker compose up -d --build
```

Abra **http://localhost:8080**. Para outras pessoas na mesma rede, use `http://IP-DO-SEU-COMPUTADOR:8080`.

## Configurar

Edite o `.env` e rode `docker compose up -d` de novo.

| Variável | Padrão | O que faz |
|---|---|---|
| `WIDTH` / `HEIGHT` | 32 / 32 | Tamanho do mural (4 a 128) |
| `COOLDOWN_SECONDS` | 5 | Espera entre uma jogada e outra |
| `MAX_BATCH` | 10 | Pixels por jogada |
| `MAX_PIXELS_PER_USER` | 0 | Limite por pessoa (0 = sem limite) |
| `ADMIN_KEY` | host123 | Chave do host. **Troque.** |
| `POSTGRES_PASSWORD` | pixelpass | Senha do banco. **Troque.** |

Cada tamanho tem o seu próprio mural, e os tamanhos já usados ficam guardados no banco.

## Testar

```bash
docker compose ps                                # todos healthy/running
curl http://localhost:8080/api/health            # {"status":"ok",...}
docker compose --profile test run --rm tests     # testes automáticos
```

Escalar a API para 3 réplicas:

```bash
docker compose up -d --scale app=3
docker compose restart nginx
```

## Painel do host

Abra `http://localhost:8080/?admin=SUA_CHAVE` para limpar o mural e ver os tamanhos já usados.

## Parar

```bash
docker compose down        # mantém os dados
docker compose down -v     # apaga também o mural e o histórico
```

Mais detalhes (arquitetura, comandos do Redis e Postgres, problemas comuns): [docs/DETALHES.md](docs/DETALHES.md).
