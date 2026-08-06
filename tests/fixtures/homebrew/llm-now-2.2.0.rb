# typed: false
# frozen_string_literal: true

class LlmNow < Formula
  desc "Make one text-generation call through an available LLM provider"
  homepage "https://github.com/swartzrock/llm-now"
  version "2.2.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/swartzrock/llm-now/releases/download/v2.2.0/llm-now-v2.2.0-macos-arm64.zip"
      sha256 "ebcbd034d2cd79087d381a8f9c8feb656d061018e2a881ca78449071e7693af9"
    end

    on_intel do
      url "https://github.com/swartzrock/llm-now/releases/download/v2.2.0/llm-now-v2.2.0-macos-x64.zip"
      sha256 "0a90f852414c6a2e2a71d955ea5897cffaf9a5006f54d33ba1511d47c1170f5b"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/swartzrock/llm-now/releases/download/v2.2.0/llm-now-v2.2.0-linux-arm64.zip"
      sha256 "d390322eff9d48fb7127cc608d186ad377c01407339c611e9422a1903cc08bd9"
    end

    on_intel do
      url "https://github.com/swartzrock/llm-now/releases/download/v2.2.0/llm-now-v2.2.0-linux-x64.zip"
      sha256 "ad9d81af159a716bb656af46c4f1bbcafe58dafb2fdb3cf2d55bb6b17f761cab"
    end
  end

  def install
    bin.install "llm-now"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/llm-now --version")
  end
end
