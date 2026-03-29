import { createGlobalStyle } from 'styled-components'

export const GlobalStyles = createGlobalStyle`
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  html, body, #root {
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  body {
    font-family: ${({ theme }) => theme.fonts.sans};
    background-color: ${({ theme }) => theme.colors.base};
    color: ${({ theme }) => theme.colors.text};
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  a {
    color: ${({ theme }) => theme.colors.blue};
    text-decoration: none;

    &:hover {
      color: ${({ theme }) => theme.colors.sapphire};
      text-decoration: underline;
    }
  }

  ::-webkit-scrollbar {
    width: 8px;
    height: 8px;
  }

  ::-webkit-scrollbar-track {
    background: ${({ theme }) => theme.colors.mantle};
  }

  ::-webkit-scrollbar-thumb {
    background: ${({ theme }) => theme.colors.surface1};
    border-radius: 4px;
  }

  ::-webkit-scrollbar-thumb:hover {
    background: ${({ theme }) => theme.colors.surface2};
  }
`
