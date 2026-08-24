package manager

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"frp-manager/internal/frp"
)

type Runner interface {
	Verify(configPath string) error
	Restart() error
	ConfigureControlPorts(bindPort int, ranges []frp.PortRange) error
}

type Store struct {
	StatePath  string
	ConfigPath string
	ConfigMode os.FileMode
	ConfigGID  int
	Runner     Runner
	mu         sync.Mutex
}

func (s *Store) Load() (frp.Settings, error) {
	var settings frp.Settings
	data, err := os.ReadFile(s.StatePath)
	if err != nil {
		return settings, err
	}
	if err := json.Unmarshal(data, &settings); err != nil {
		return settings, fmt.Errorf("读取管理状态失败: %w", err)
	}
	return settings, nil
}

func readExisting(path string) ([]byte, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func writeSecure(path string, data []byte, mode os.FileMode, gid int) error {
	if mode == 0 {
		mode = 0o600
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".frp-manager-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	// Windows does not replace an existing destination with os.Rename. Removing
	// first keeps tests portable; the verified source and in-memory rollback data
	// still ensure a failed service restart restores the previous configuration.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(tempName, path); err != nil {
		return err
	}
	if gid > 0 {
		if err := os.Chown(path, -1, gid); err != nil {
			return err
		}
	}
	return nil
}

func restore(path string, data []byte, existed bool, mode os.FileMode, gid int) {
	if existed {
		_ = writeSecure(path, data, mode, gid)
	} else {
		_ = os.Remove(path)
	}
}

func (s *Store) Apply(settings frp.Settings, occupied []int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Runner == nil {
		return errors.New("服务执行器未配置")
	}
	if err := settings.Validate(occupied); err != nil {
		return err
	}
	config, err := settings.RenderTOML()
	if err != nil {
		return err
	}
	state, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	verifyFile, err := os.CreateTemp(filepath.Dir(s.ConfigPath), ".frps-verify-*.toml")
	if err != nil {
		return fmt.Errorf("创建校验配置失败: %w", err)
	}
	verifyPath := verifyFile.Name()
	defer os.Remove(verifyPath)
	if _, err := verifyFile.WriteString(config); err != nil {
		verifyFile.Close()
		return err
	}
	if err := verifyFile.Close(); err != nil {
		return err
	}
	if err := s.Runner.Verify(verifyPath); err != nil {
		return fmt.Errorf("frps 拒绝新配置: %w", err)
	}

	oldState, stateExisted, err := readExisting(s.StatePath)
	if err != nil {
		return err
	}
	oldConfig, configExisted, err := readExisting(s.ConfigPath)
	if err != nil {
		return err
	}
	if err := writeSecure(s.ConfigPath, []byte(config), s.ConfigMode, s.ConfigGID); err != nil {
		return fmt.Errorf("写入 frps 配置失败: %w", err)
	}
	if err := writeSecure(s.StatePath, state, 0o600, 0); err != nil {
		restore(s.ConfigPath, oldConfig, configExisted, s.ConfigMode, s.ConfigGID)
		return fmt.Errorf("写入管理状态失败: %w", err)
	}
	if err := s.Runner.Restart(); err != nil {
		restore(s.ConfigPath, oldConfig, configExisted, s.ConfigMode, s.ConfigGID)
		restore(s.StatePath, oldState, stateExisted, 0o600, 0)
		rollbackErr := s.Runner.Restart()
		if rollbackErr != nil {
			return fmt.Errorf("新配置启动失败 (%v)，回滚后的服务也未能启动 (%v)", err, rollbackErr)
		}
		return fmt.Errorf("新配置启动失败，已恢复上一版本: %w", err)
	}
	if err := s.Runner.ConfigureControlPorts(settings.BindPort, settings.EffectiveControlPorts()); err != nil {
		restore(s.ConfigPath, oldConfig, configExisted, s.ConfigMode, s.ConfigGID)
		restore(s.StatePath, oldState, stateExisted, 0o600, 0)
		oldSettings := frp.Settings{BindPort: settings.BindPort}
		if stateExisted {
			_ = json.Unmarshal(oldState, &oldSettings)
		}
		restartErr := s.Runner.Restart()
		controlRollbackErr := s.Runner.ConfigureControlPorts(oldSettings.BindPort, oldSettings.EffectiveControlPorts())
		if restartErr != nil || controlRollbackErr != nil {
			return fmt.Errorf("客户端接入端口配置失败 (%v)，回滚异常 (frps=%v, 入口=%v)", err, restartErr, controlRollbackErr)
		}
		return fmt.Errorf("客户端接入端口配置失败，已恢复上一版本: %w", err)
	}
	return nil
}
