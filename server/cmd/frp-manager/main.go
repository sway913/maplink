package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"frp-manager/internal/auth"
	"frp-manager/internal/manager"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value == 0 {
		return fallback
	}
	return value
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		password := os.Getenv("FRP_MANAGER_PASSWORD")
		if password == "" {
			log.Fatal("FRP_MANAGER_PASSWORD 环境变量不能为空")
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(hash)
		return
	}

	frpsBinary := env("FRP_MANAGER_FRPS_BINARY", "/usr/local/bin/frps")
	unit := env("FRP_MANAGER_FRPS_UNIT", "frps.service")
	system := manager.SystemRunner{
		FRPSBinary: frpsBinary, Unit: unit,
		ControlServiceUnit: env("FRP_MANAGER_CONTROL_SERVICE_UNIT", "frp-control.service"),
		ControlNFTPath:     env("FRP_MANAGER_CONTROL_NFT_PATH", "/etc/frp-manager/control-ports.nft"),
		NFTBinary:          env("FRP_MANAGER_NFT_BINARY", "/usr/sbin/nft"),
		PublicIP:           os.Getenv("FRP_MANAGER_PUBLIC_IP"),
	}
	store := &manager.Store{
		StatePath:  env("FRP_MANAGER_STATE", "/etc/frp-manager/state.json"),
		ConfigPath: env("FRP_MANAGER_FRPS_CONFIG", "/etc/frp/frps.toml"),
		ConfigMode: 0o640,
		ConfigGID:  envInt("FRP_MANAGER_FRPS_GID", 0),
		Runner:     system,
	}
	port := envInt("FRP_MANAGER_PORT", 7400)
	server, err := manager.NewServer(manager.ServerOptions{
		Store: store, System: system, AdminUser: env("FRP_MANAGER_ADMIN_USER", "admin"),
		AdminHash: os.Getenv("FRP_MANAGER_ADMIN_HASH"), AdminHashPath: env("FRP_MANAGER_ADMIN_HASH_PATH", "/etc/frp-manager/admin-password.hash"), PublicIP: os.Getenv("FRP_MANAGER_PUBLIC_IP"),
		WebRoot: env("FRP_MANAGER_WEB_ROOT", "/opt/frp-manager/web"), ManagerPort: port, SessionSecure: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{
		Addr: fmt.Sprintf("0.0.0.0:%d", port), Handler: server.Handler(),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
	cert := env("FRP_MANAGER_TLS_CERT", "/etc/frp-manager/tls.crt")
	key := env("FRP_MANAGER_TLS_KEY", "/etc/frp-manager/tls.key")
	log.Printf("MapLink Server listening on https://0.0.0.0:%d", port)
	log.Fatal(httpServer.ListenAndServeTLS(cert, key))
}
